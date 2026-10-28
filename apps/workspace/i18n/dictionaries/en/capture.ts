/**
 * Capture from where the reader stands: the composer's attach menu, photos
 * from the camera and the photo library, and dictation's on-screen states.
 */
export const capture = {
  attach: {
    menuLabel: 'Add to this chat',
    takePhoto: 'Take photo',
    takePhotoHint: 'Opens the camera',
    photoLibrary: 'From photo library',
    photoLibraryHint: 'Photos on this device',
    chooseFile: 'Choose file',
    chooseFileHint: 'PDF, Office and more',
    destinationChat: 'Lands in this chat only. For the project files, upload under “Files”.',
  },
  photos: {
    fileNamePrefix: 'Photo',
    unavailableVision:
      'Photos are not possible here yet: {productName} needs an image model to read them, and none is set up for your office.',
    unavailableNotEnabled: 'Photos are not enabled for your office yet.',
    heicUnconvertible:
      '“{name}” is a HEIC photo this browser cannot convert to JPEG. Picked through “From photo library”, it arrives as JPEG.',
    folderDestination: 'Lands in the folder you are in.',
  },
  dictation: {
    recording: 'Recording',
    tapToInsert: 'Tap to insert',
    elapsedOfLimit: '{elapsed} of {limit}',
    transcribing: 'Turning speech into text …',
    dismiss: 'Dismiss',
  },
}
