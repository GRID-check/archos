/**
 * System notifications for the inbox (Web Push, ADR-0112): the settings
 * section, the prompt in the inbox, and the one line a notification carries
 * when the person asked for no preview.
 */
export const notifications = {
  title: 'Notifications',
  description:
    'Piloti tells you on this device as soon as something lands in your inbox, even when Piloti is not open.',
  push: {
    /** A notification with the lock-screen preview off: no name, no subject. */
    genericTitle: 'New message in Piloti',
  },
  device: {
    label: 'Notify me on this device',
    hint: 'Your browser asks for permission once. You can turn it off here at any time.',
    turnOn: 'Turn on',
    turnOff: 'Turn off',
    working: 'One moment…',
    on: 'On for this device',
    failed: 'Notifications could not be turned on. Please try again.',
    removeFailed: 'The device could not be removed. Please try again.',
  },
  states: {
    unsupported: {
      title: 'This browser cannot show notifications',
      body: 'Use a current version of Chrome, Edge, Firefox or Safari to be notified here.',
    },
    denied: {
      title: 'Notifications are blocked for Piloti',
      body: 'Allow them in your browser: open the site settings next to the address (the lock icon), set Notifications to Allow and reload this page.',
    },
    needsInstall: {
      title: 'Add Piloti to your Home Screen first',
      body: 'On iPhone and iPad, notifications only work for an installed app. In Safari tap Share, choose Add to Home Screen, open Piloti from there and turn them on here.',
    },
  },
  devices: {
    title: 'Your devices',
    empty: 'No device receives notifications yet.',
    thisDevice: 'This device',
    lastDelivered: 'Last notified {time}',
    neverDelivered: 'Nothing delivered yet',
    remove: 'Remove',
    removeLabel: 'Remove {device}',
  },
  categories: {
    title: 'What Piloti notifies you about',
    requests: {
      label: 'Requests to you',
      hint: 'Someone asks for your view, Piloti has a question, something waits for your decision.',
    },
    results: {
      label: 'Results',
      hint: 'Finished background work and what went wrong with it.',
    },
    access: {
      label: 'Access and assignments',
      hint: 'A chat is shared with you, a file is assigned to you.',
    },
    activity: {
      label: 'Activity',
      hint: 'New messages in chats, finished uploads, new Fassungen of documents you follow.',
    },
    office: {
      label: 'Office notices',
      hint: 'Storage, held files and other things about your office.',
    },
  },
  preview: {
    label: 'Show content on the lock screen',
    hint: 'Off, a notification only says that something arrived, without names or subjects.',
  },
  preferencesFailed: 'Your choice could not be saved. Please try again.',
  prompt: {
    title: 'Get notified when something arrives?',
    body: 'Piloti can tell you on this device as soon as something lands in your inbox.',
    turnOn: 'Turn on',
    dismiss: 'Not now',
    dismissLabel: 'Dismiss the notification suggestion',
  },
}
