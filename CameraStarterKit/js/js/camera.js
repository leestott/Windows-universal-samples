﻿//*********************************************************
//
// Copyright (c) Microsoft. All rights reserved.
// This code is licensed under the MIT License (MIT).
// THIS CODE IS PROVIDED *AS IS* WITHOUT WARRANTY OF
// ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING ANY
// IMPLIED WARRANTIES OF FITNESS FOR A PARTICULAR
// PURPOSE, MERCHANTABILITY, OR NON-INFRINGEMENT.
//
//*********************************************************

(function () {
    "use strict";

    var Capture = Windows.Media.Capture;
    var DeviceInformation = Windows.Devices.Enumeration.DeviceInformation;
    var DeviceClass = Windows.Devices.Enumeration.DeviceClass;
    var DisplayOrientations = Windows.Graphics.Display.DisplayOrientations;
    var FileProperties = Windows.Storage.FileProperties;
    var SimpleOrientation = Windows.Devices.Sensors.SimpleOrientation;
    var SimpleOrientationSensor = Windows.Devices.Sensors.SimpleOrientationSensor;

    // Receive notifications about rotation of the device and UI and apply any necessary rotation to the preview stream and UI controls
    var oOrientationSensor = SimpleOrientationSensor.getDefault(),
        oDisplayInformation = Windows.Graphics.Display.DisplayInformation.getForCurrentView(),
        oDeviceOrientation = SimpleOrientation.notRotated,
        oDisplayOrientation = DisplayOrientations.portrait;

    // Prevent the screen from sleeping while the camera is running
    var oDisplayRequest = new Windows.System.Display.DisplayRequest();

    // MediaCapture and its state variables
    var oMediaCapture = null,
        isInitialized = false,
        isPreviewing = false,
        isRecording = false;

    // Information about the camera device
    var externalCamera = false,
        mirroringPreview = false;
    
    // Rotation metadata to apply to the preview stream and recorded videos (MF_MT_VIDEO_ROTATION)
    // Reference: http://msdn.microsoft.com/en-us/library/windows/apps/xaml/hh868174.aspx
    var RotationKey = "C380465D-2271-428C-9B83-ECEA3B4A85C1";

    // Initialization
    var app = WinJS.Application;
    var activation = Windows.ApplicationModel.Activation;
    app.onactivated = function (args) {
        if (args.detail.kind === activation.ActivationKind.launch) {
            if (args.detail.previousExecutionState !== activation.ApplicationExecutionState.terminated) {
                document.getElementById("photoButton").addEventListener("click", photoButton_tapped);
                document.getElementById("videoButton").addEventListener("click", videoButton_tapped);

                setupUiAsync();
                initializeCameraAsync();
            // Reactivated from an OS suspension
            } else {
                setupUiAsync();
                initializeCameraAsync();
            }
            args.setPromise(WinJS.UI.processAll());
        }
    };
    
    // About to be suspended
    app.oncheckpoint = function (args) {
        cleanupCameraAsync()
        .then(function () {
            args.setPromise(cleanupUiAsync());
        }).done();
    };

    // Resuming from a user suspension
    Windows.UI.WebUI.WebUIApplication.addEventListener("resuming", function () {
        setupUiAsync();
        initializeCameraAsync();
    }, false);
    
    // Closing
    app.onunload = function (args) {
        document.getElementById("photoButton").removeEventListener("click", photoButton_tapped);
        document.getElementById("videoButton").removeEventListener("click", videoButton_tapped);

        cleanupCameraAsync()
        .then(function () {
            args.setPromise(cleanupUiAsync());
        }).done();
    };

    /// <summary>
    /// Initializes the MediaCapture, registers events, gets camera device information for mirroring and rotating, starts preview and unlocks the UI
    /// </summary>
    /// <returns></returns>
    function initializeCameraAsync() {
        console.log("InitializeCameraAsync");

        // Get available devices for capturing pictures
        return findCameraDeviceByPanelAsync(Windows.Devices.Enumeration.Panel.back)
        .then(function (camera) {
            if (camera === null) {
                console.log("No camera device found!");
                return;
            }
            // Figure out where the camera is located
            if (!camera.enclosureLocation || camera.enclosureLocation.panel === Windows.Devices.Enumeration.Panel.unknown) {
                // No information on the location of the camera, assume it's an external camera, not integrated on the device
                externalCamera = true;
            }
            else {
                // Camera is fixed on the device
                externalCamera = false;

                // Only mirror the preview if the camera is on the front panel
                mirroringPreview = (camera.enclosureLocation.panel === Windows.Devices.Enumeration.Panel.front);
            }

            oMediaCapture = new Capture.MediaCapture();

            // Register for a notification when video recording has reached the maximum time and when something goes wrong
            oMediaCapture.addEventListener("recordlimitationexceeded", mediaCapture_recordLimitationExceeded);
            oMediaCapture.addEventListener("failed", mediaCapture_failed);

            var settings = new Capture.MediaCaptureInitializationSettings();
            settings.videoDeviceId = camera.id;
            settings.streamingCaptureMode = Capture.StreamingCaptureMode.audioAndVideo;

            // Initialize media capture and start the preview
            return oMediaCapture.initializeAsync(settings)
            .then(function () {
                isInitialized = true;
                startPreview();
            });
        }, function (error) {
            console.log(error.message);
        }).done();
    }

    /// <summary>
    /// Cleans up the camera resources (after stopping any video recording and/or preview if necessary) and unregisters from MediaCapture events
    /// </summary>
    /// <returns></returns>
    function cleanupCameraAsync() {
        console.log("cleanupCameraAsync");

        var promiseList = {};

        if (isInitialized) {
            // If a recording is in progress during cleanup, stop it to save the recording
            if (isRecording) {
                var stopRecordPromise = stopRecordingAsync();
                promiseList[promiseList.length] = stopRecordPromise;
            }

            if (isPreviewing) {
                // The call to stop the preview is included here for completeness, but can be
                // safely removed if a call to MediaCapture.close() is being made later,
                // as the preview will be automatically stopped at that point
                stopPreview();
            }

            isInitialized = false;
        }

        // When all our tasks complete, clean up MediaCapture
        return WinJS.Promise.join(promiseList)
        .then(function () {
            if (oMediaCapture != null) {
                oMediaCapture.removeEventListener("recordlimitationexceeded", mediaCapture_recordLimitationExceeded);
                oMediaCapture.removeEventListener("failed", mediaCapture_failed);
                oMediaCapture.close();
                oMediaCapture = null;
            }
        });
    }

    /// <summary>
    /// Starts the preview and adjusts it for for rotation and mirroring after making a request to keep the screen on
    /// </summary>
    function startPreview() {
        // Prevent the device from sleeping while the preview is running
        oDisplayRequest.requestActive();

        // Set the preview source in the UI and mirror it if necessary
        var previewVidTag = document.getElementById("cameraPreview");
        if (mirroringPreview) {
            cameraPreview.style.transform = "scale(-1, 1)";
        }

        var previewUrl = URL.createObjectURL(oMediaCapture);
        previewVidTag.src = previewUrl;
        previewVidTag.play();

        previewVidTag.addEventListener("playing", function () {
            isPreviewing = true;
            updateCaptureControls();
            setPreviewRotationAsync();
        });
    }

    /// <summary>
    /// Gets the current orientation of the UI in relation to the device (when AutoRotationPreferences cannot be honored) and applies a corrective rotation to the preview
    /// </summary>
    /// <returns></returns>
    function setPreviewRotationAsync()
    {
        // Calculate which way and how far to rotate the preview
        var rotationDegrees = convertDisplayOrientationToDegrees(oDisplayOrientation);

        // The rotation direction needs to be inverted if the preview is being mirrored
        if (mirroringPreview)
        {
            rotationDegrees = (360 - rotationDegrees) % 360;
        }

        // Add rotation metadata to the preview stream to make sure the aspect ratio / dimensions match when rendering and getting preview frames
        var props = oMediaCapture.videoDeviceController.getMediaStreamProperties(Capture.MediaStreamType.videoPreview);
        props.properties.insert(RotationKey, rotationDegrees);
        return oMediaCapture.setEncodingPropertiesAsync(Capture.MediaStreamType.videoPreview, props, null);
    }

    /// <summary>
    /// Stops the preview and deactivates a display request, to allow the screen to go into power saving modes
    /// </summary>
    /// <returns></returns>
    function stopPreview() {
        isPreviewing = false;

        // Cleanup the UI
        var previewVidTag = document.getElementById("cameraPreview");
        previewVidTag.pause();
        previewVidTag.src = null;

        // Allow the device screen to sleep now that the preview is stopped
        oDisplayRequest.requestRelease();
    }

    /// <summary>
    /// Takes a photo to a StorageFile and adds rotation metadata to it
    /// </summary>
    /// <returns></returns>
    function takePhotoAsync() {
        // While taking a photo, keep the video button enabled only if the camera supports simultaneously taking pictures and recording video
        videoButton.disabled = oMediaCapture.mediaCaptureSettings.concurrentRecordAndPhotoSupported;

        var Streams = Windows.Storage.Streams;
        var inputStream = new Streams.InMemoryRandomAccessStream();

        // Take the picture
        console.log("Taking photo...");
        return oMediaCapture.capturePhotoToStreamAsync(Windows.Media.MediaProperties.ImageEncodingProperties.createJpeg(), inputStream)
        .then(function () {
            console.log("Photo taken!");

            // Done taking a photo, so re-enable the button
            videoButton.disabled = false;

            var photoOrientation = convertOrientationToPhotoOrientation(getCameraOrientation());
            return reencodeAndSavePhotoAsync(inputStream, photoOrientation);
        }, function (error) {
            console.log(error.message);
        }).done();
    }

    /// <summary>
    /// Records an MP4 video to a StorageFile and adds rotation metadata to it
    /// </summary>
    /// <returns></returns>
    function startRecordingAsync() {
        return Windows.Storage.KnownFolders.picturesLibrary.createFileAsync("SimpleVideo.mp4", Windows.Storage.CreationCollisionOption.generateUniqueName)
        .then(function (file) {
            // Calculate rotation angle, taking mirroring into account if necessary
            var rotationAngle = 360 - convertDeviceOrientationToDegrees(getCameraOrientation());
            var encodingProfile = Windows.Media.MediaProperties.MediaEncodingProfile.createMp4(Windows.Media.MediaProperties.VideoEncodingQuality.auto);
            encodingProfile.video.properties.insert(RotationKey, rotationAngle);

            console.log("Starting recording...");
            return oMediaCapture.startRecordToStorageFileAsync(encodingProfile, file)
            .then(function () {
                isRecording = true;
                console.log("Started recording!");
            });
        });
    }

    /// <summary>
    /// Stops recording a video
    /// </summary>
    /// <returns></returns>
    function stopRecordingAsync() {
        console.log("Stopping recording...");
        return oMediaCapture.stopRecordAsync()
        .then(function () {
            isRecording = false;
            console.log("Stopped recording!");
        });
    }

    /// <summary>
    /// Attempts to find and return a device mounted on the panel specified, and on failure to find one it will return the first device listed
    /// </summary>
    /// <param name="panel">The desired panel on which the returned device should be mounted, if available</param>
    /// <returns></returns>
    function findCameraDeviceByPanelAsync(panel) {
        var deviceInfo = null;
        // Get available devices for capturing pictures
        return DeviceInformation.findAllAsync(DeviceClass.videoCapture)
        .then(function (devices) {
            devices.forEach(function (cameraDeviceInfo) {
                if (cameraDeviceInfo.enclosureLocation != null && cameraDeviceInfo.enclosureLocation.panel === panel) {
                    deviceInfo = cameraDeviceInfo;
                    return;
                }
            });

            // Nothing matched, just return the first
            if (!deviceInfo && devices.length > 0) {
                deviceInfo = devices.getAt(0);
            }

            return deviceInfo;
        });
    }

    /// <summary>
    /// Applies the given orientation to a photo stream and saves it as a StorageFile
    /// </summary>
    /// <param name="stream">The photo stream</param>
    /// <param name="photoOrientation">The orientation metadata to apply to the photo</param>
    /// <returns></returns>
    function reencodeAndSavePhotoAsync(inputStream, orientation) {
        var Imaging = Windows.Graphics.Imaging;
        var bitmapDecoder = null,
            bitmapEncoder = null,
            outputStream = null;

        return Imaging.BitmapDecoder.createAsync(inputStream)
        .then(function (decoder) {
            bitmapDecoder = decoder;
            return Windows.Storage.KnownFolders.picturesLibrary.createFileAsync("SimplePhoto.jpg", Windows.Storage.CreationCollisionOption.generateUniqueName);
        }).then(function (file) {
            return file.openAsync(Windows.Storage.FileAccessMode.readWrite);
        }).then(function (outStream) {
            outputStream = outStream;
            return Imaging.BitmapEncoder.createForTranscodingAsync(outputStream, bitmapDecoder);
        }).then(function (encoder) {
            bitmapEncoder = encoder;
            var properties = new Imaging.BitmapPropertySet();
            properties.insert("System.Photo.Orientation", new Imaging.BitmapTypedValue(orientation, Windows.Foundation.PropertyType.uint16));
            return bitmapEncoder.bitmapProperties.setPropertiesAsync(properties)
        }).then(function() {
            return bitmapEncoder.flushAsync();
        }).then(function () {
            inputStream.close();
            outputStream.close();
        });
    }

    /// <summary>
    /// This method will update the icons, enable/disable and show/hide the photo/video buttons depending on the current state of the app and the capabilities of the device
    /// </summary>
    function updateCaptureControls() {
        // The buttons should only be enabled if the preview started sucessfully
        photoButton.disabled = !isPreviewing;
        videoButton.disabled = !isPreviewing;

        // Update recording button to show "Stop" icon instead of red "Record" icon
        var vidButton = document.getElementById("videoButton").winControl;
        if (isRecording) {
            vidButton.icon = "stop";
        }
        else {
            vidButton.icon = "video";
        }

        // If the camera doesn't support simultaneously taking pictures and recording video, disable the photo button on record
        if (isInitialized && !oMediaCapture.mediaCaptureSettings.concurrentRecordAndPhotoSupported) {
            photoButton.disabled = isRecording;
        }
    }
    
    /// <summary>
    /// Attempts to lock the page orientation, hide the StatusBar (on Phone) and registers event handlers for hardware buttons and orientation sensors
    /// </summary>
    function setupUiAsync() {
        var Display = Windows.Graphics.Display;

        // Attempt to lock page to landscape orientation to prevent the CaptureElement from rotating, as this gives a better experience
        Display.DisplayInformation.autoRotationPreferences = Display.DisplayOrientations.landscape;

        registerEventHandlers();

        // Populate orientation variables with the current state
        oDisplayOrientation = oDisplayInformation.currentOrientation;
        if (oOrientationSensor != null) {
            oDeviceOrientation = oOrientationSensor.getCurrentOrientation();
        }

        // Hide the status bar
        if (Windows.Foundation.Metadata.ApiInformation.isTypePresent("Windows.UI.ViewManagement.StatusBar")) {
            return Windows.UI.ViewManagement.StatusBar.getForCurrentView().hideAsync();
        }
        else {
            return WinJS.Promise.as();
        }
    }

    /// <summary>
    /// Unregisters event handlers for hardware buttons and orientation sensors, allows the StatusBar (on Phone) to show, and removes the page orientation lock
    /// </summary>
    /// <returns></returns>
    function cleanupUiAsync() {
        unregisterEventHandlers();

        // Revert orientation preferences
        oDisplayInformation.AutoRotationPreferences = DisplayOrientations.none;

        // Show the status bar
        if (Windows.Foundation.Metadata.ApiInformation.isTypePresent("Windows.UI.ViewManagement.StatusBar")) {
            return Windows.UI.ViewManagement.StatusBar.getForCurrentView().showAsync();
        }
        else {
            return WinJS.Promise.as();
        }
    }

    /// <summary>
    /// Registers event handlers for hardware buttons and orientation sensors, and performs an initial update of the UI rotation
    /// </summary>
    function registerEventHandlers()
    {
        if (Windows.Foundation.Metadata.ApiInformation.isTypePresent("Windows.Phone.UI.Input.HardwareButtons"))
        {
            Windows.Phone.UI.Input.HardwareButtons.addEventListener("camerapressed", hardwareButtons_cameraPress);
        }

        // If there is an orientation sensor present on the device, register for notifications
        if (oOrientationSensor != null) {
            oOrientationSensor.addEventListener("orientationchanged", orientationSensor_orientationChanged);
        
            // Update orientation of buttons with the current orientation
            updateButtonOrientation();
        }

        oDisplayInformation.addEventListener("orientationchanged", displayInformation_orientationChanged);
    }

    /// <summary>
    /// Unregisters event handlers for hardware buttons and orientation sensors
    /// </summary>
    function unregisterEventHandlers()
    {
        if (Windows.Foundation.Metadata.ApiInformation.isTypePresent("Windows.Phone.UI.Input.HardwareButtons"))
        {
            Windows.Phone.UI.Input.HardwareButtons.removeEventListener("camerapressed", hardwareButtons_cameraPress);
        }

        if (oOrientationSensor != null) {
            oOrientationSensor.removeEventListener("orientationchanged", orientationSensor_orientationChanged);
        }

        oDisplayInformation.removeEventListener("orientationchanged", displayInformation_orientationChanged);
    }

    /// <summary>
    /// Calculates the current camera orientation from the device orientation by taking into account whether the camera is external or facing the user
    /// </summary>
    /// <returns>The camera orientation in space, with an inverted rotation in the case the camera is mounted on the device and is facing the user</returns>
    function getCameraOrientation() {
        if (externalCamera) {
            // Cameras that are not attached to the device do not rotate along with it, so apply no rotation
            return SimpleOrientation.notRotated;
        }

        var result = oDeviceOrientation;

        // Account for the fact that, on portrait-first devices, the camera sensor is mounted at a 90 degree offset to the native orientation
        if (oDisplayInformation.nativeOrientation === DisplayOrientations.portrait) {
            switch (result) {
                case SimpleOrientation.rotated90DegreesCounterclockwise:
                    result = SimpleOrientation.notRotated;
                    break;
                case SimpleOrientation.rotated180DegreesCounterclockwise:
                    result = SimpleOrientation.rotated90DegreesCounterclockwise;
                    break;
                case SimpleOrientation.rotated270DegreesCounterclockwise:
                    result = SimpleOrientation.rotated180DegreesCounterclockwise;
                    break;
                case SimpleOrientation.notRotated:
                default:
                    result = SimpleOrientation.rotated270DegreesCounterclockwise;
                    break;
            }
        }

        // If the preview is being mirrored for a front-facing camera, then the rotation should be inverted
        if (mirroringPreview) {
            // This only affects the 90 and 270 degree cases, because rotating 0 and 180 degrees is the same clockwise and counter-clockwise
            switch (result) {
                case SimpleOrientation.rotated90DegreesCounterclockwise:
                    return SimpleOrientation.rotated270DegreesCounterclockwise;
                case SimpleOrientation.rotated270DegreesCounterclockwise:
                    return SimpleOrientation.rotated90DegreesCounterclockwise;
            }
        }

        return result;
    }

    /// <summary>
    /// Converts the given orientation of the device in space to the metadata that can be added to captured photos
    /// </summary>
    /// <param name="orientation">The orientation of the device in space</param>
    /// <returns></returns>
    function convertOrientationToPhotoOrientation(orientation) {
        switch (orientation) {
            case SimpleOrientation.rotated90DegreesCounterclockwise:
                return FileProperties.PhotoOrientation.rotate90;
            case SimpleOrientation.rotated180DegreesCounterclockwise:
                return FileProperties.PhotoOrientation.rotate180;
            case SimpleOrientation.rotated270DegreesCounterclockwise:
                return FileProperties.PhotoOrientation.rotate270;
            case SimpleOrientation.notRotated:
            default:
                return FileProperties.PhotoOrientation.normal;
        }
    }

    /// <summary>
    /// Converts the given orientation of the device in space to the corresponding rotation in degrees
    /// </summary>
    /// <param name="orientation">The orientation of the device in space</param>
    /// <returns>An orientation in degrees</returns>
    function convertDeviceOrientationToDegrees(orientation) {
        switch (orientation) {
            case SimpleOrientation.rotated90DegreesCounterclockwise:
                return 90;
            case SimpleOrientation.rotated180DegreesCounterclockwise:
                return 180;
            case SimpleOrientation.rotated270DegreesCounterclockwise:
                return 270;
            case SimpleOrientation.notRotated:
            default:
                return 0;
        }
    }

    /// <summary>
    /// Converts the given orientation of the app on the screen to the corresponding rotation in degrees
    /// </summary>
    /// <param name="orientation">The orientation of the app on the screen</param>
    /// <returns>An orientation in degrees</returns>
    function convertDisplayOrientationToDegrees(orientation) {
        switch (orientation) {
            case DisplayOrientations.portrait:
                return 90;
            case DisplayOrientations.LandscapeFlipped:
                return 180;
            case DisplayOrientations.PortraitFlipped:
                return 270;
            case DisplayOrientations.Landscape:
            default:
                return 0;
        }
    }

    /// <summary>
    /// Uses the current device orientation in space and page orientation on the screen to calculate the rotation
    /// transformation to apply to the controls
    /// </summary>
    function updateButtonOrientation() {
        var currDeviceOrientation = convertDeviceOrientationToDegrees(oDeviceOrientation);
        var currDisplayOrientation = convertDisplayOrientationToDegrees(oDisplayOrientation);

        if (oDisplayInformation.nativeOrientation === DisplayOrientations.portrait) {
            currDeviceOrientation -= 90;
        }

        // Combine both rotations and make sure that 0 <= result < 360
        var angle = (360 + currDisplayOrientation + currDeviceOrientation) % 360;

        // Rotate the buttons in the UI to match the rotation of the device
        videoButton.style.transform = "rotate(" + angle + "deg)";
        photoButton.style.transform = "rotate(" + angle + "deg)";
    }

    /// <summary>
    /// This event will fire when the page is rotated, when the DisplayInformation.AutoRotationPreferences value set in the setupUiAsync() method cannot be not honored.
    /// </summary>
    /// <param name="sender">The event source.</param>
    function displayInformation_orientationChanged(sender) {
        oDisplayOrientation = sender.currentOrientation;

        if (isPreviewing) {
            setPreviewRotationAsync();
        }
       
        updateButtonOrientation();
    }

    function photoButton_tapped() {
        takePhotoAsync();
    }

    function videoButton_tapped() {
        var promiseToExecute = null;
        if (!isRecording) {
            promiseToExecute = startRecordingAsync();
        }
        else {
            promiseToExecute = stopRecordingAsync();
        }
        
        promiseToExecute
        .then(function () {
            updateCaptureControls();
        }, function (error) {
            console.log(error.message);
        }).done();
    }

    /// <summary>
    /// Occurs each time the simple orientation sensor reports a new sensor reading.
    /// </summary>
    /// <param name="args">The event data.</param>
    function orientationSensor_orientationChanged(args) {
        // If the device is parallel to the ground, keep the last orientation used. This allows users to take pictures of documents (FaceUp)
        // or the ceiling (FaceDown) in any orientation, by first holding the device in the desired orientation, and then pointing the camera
        // at the desired subject.
        if (args.orientation != SimpleOrientation.faceup && args.orientation != SimpleOrientation.facedown) {
            oDeviceOrientation = args.orientation;
            updateButtonOrientation();
        }
    }

    function hardwareButtons_cameraPress()
    {
        takePhotoAsync();
    }

    /// <summary>
    /// This is a notification that recording has to stop, and the app is expected to finalize the recording
    /// </summary>
    function mediaCapture_recordLimitationExceeded() {
        stopRecordingAsync()
        .done(function () {
            updateCaptureControls();
        });
    }

    function mediaCapture_failed(errorEventArgs)
    {
        console.log("MediaCapture_Failed: 0x" + errorEventArgs.code + ": " + errorEventArgs.message);

        cleanupCameraAsync()
        .done(function() {
            updateCaptureControls();
        });    
    }

    app.start();
})();
