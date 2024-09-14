# Obsidian Cloud Storage
[English](README.md) | [中文](README_ZH.md)

Obsidian Cloud Storage is a powerful and user-friendly plugin designed to seamlessly integrate cloud storage capabilities into your Obsidian workflow. This plugin allows you to effortlessly upload your attachments to the cloud, freeing up local storage space and enabling easy sharing and access across all your devices.

## Features

- **Automatic Cloud Upload**: Seamlessly upload attachments from specified folders to the cloud.
- **Smart Link Updating**: Automatically updates links in your notes to point to the cloud-stored files, ensuring your notes remain fully functional.
- **Flexible Storage Options**: Choose between plugin-provided cloud storage or your own S3-compatible storage solution.
- **Granular File Control**: 
  - Set up whitelists or blacklists for file extensions to precisely control which files are uploaded.
  - Define maximum file size limits for uploads to efficiently manage your storage.
- **File Management**: 
  - Option to rename files in the cloud to ensure uniqueness and avoid conflicts.
  - Choose to move or delete local files after successful upload.
- **Comprehensive Storage Management**: Easily manage your cloud storage space and uploaded files through an intuitive interface.
- **Multi-platform Sync**: Access your uploaded files from any device with internet access.

## Video Demonstrations

Here are some quick video demonstrations to help you get started with Obsidian Cloud Storage:

[![Guide](https://img.youtube.com/vi/Ga_N2WYFqi8/maxresdefault.jpg)](https://www.youtube.com/watch?v=Ga_N2WYFqi8)

## Installation

1. Open Obsidian and navigate to Settings > Community Plugins.
2. Disable Safe Mode if it's currently enabled.
3. Click on "Browse" and search for "Obsidian Cloud Storage".
4. Click "Install" next to the Obsidian Cloud Storage plugin.
5. Once installed, enable the plugin by toggling the switch next to its name.

## Quick Start Guide

1. **Account Setup**: 
   - Open the Obsidian Cloud Storage settings.
   - Click on "Sign up" to create a new account or "Log in" if you already have one.
   - Check your email and verify your account to receive additional free storage space.

2. **Configure Monitored Folders**:
   - In the plugin settings, under "General Settings", click "Add Folder".
   - Select or type the path of the folder you want to monitor for attachments.
   - Repeat this process for all folders you wish to include.

3. **Initiate Your First Upload**:
   - Open the command palette (Ctrl/Cmd + P).
   - Search for and select "Obsidian Cloud Storage: Upload all attachments".
   - The plugin will start uploading files from your monitored folders and updating links in your notes.

4. **Verify Uploads**:
   - Check the status bar at the bottom of the Obsidian window for upload progress.
   - Once complete, you can click on "Manage Storage" in the plugin settings to view your uploaded files.

## Detailed Usage Guide

### Managing Monitored Folders

- **Add a Folder**: Click "Add Folder" in the General Settings section and select the desired folder.
- **Remove a Folder**: Click the "Remove" button next to any folder you wish to stop monitoring.
- **Folder Suggestions**: As you type, the plugin will suggest existing folders in your vault for easy selection.

### File Handling Options

1. Navigate to the "General Settings" section in the plugin settings.
2. Find the "Local File Handling After Upload" option.
3. Choose between:
   - "Move to Recycle Bin": Safely moves uploaded files to your system's recycle bin.
   - "Move to Custom Folder": Relocates uploaded files to a specified folder within your vault.
4. If you choose "Move to Custom Folder", specify the folder name in the "Custom Move Folder" field below.

### Storage Type Configuration

1. Go to the "User Account" section in the plugin settings.
2. Find the "Storage Type" dropdown.
3. Choose between:
   - "Plugin-provided Storage": Uses our secure cloud storage solution.
   - "Custom S3-compatible Storage": Allows you to use your own S3 storage (coming soon).

### Advanced Features (Premium)

1. **File Filtering**:
   - In the "Subscription Features" section, find "File Filter Mode".
   - Choose between "Blacklist" (exclude specified extensions) or "Whitelist" (only include specified extensions).
   - In the "File Extensions" field, enter file extensions separated by commas (e.g., "jpg,png,pdf").

2. **Maximum File Size**:
   - In the same section, locate "Maximum File Size (MB)".
   - Enter the maximum file size in megabytes. Files larger than this will not be uploaded.

3. **File Renaming**:
   - Find the "Rename Files in Cloud" toggle.
   - Enable this to add a unique identifier to each file name upon upload, preventing conflicts.

### Storage Management

1. In the plugin settings, click on the "Manage Storage" button.
2. This will open a web interface where you can:
   - View all uploaded files
   - Delete unwanted files
   - Download files directly from the cloud

## Important Notes and Best Practices

- **Free Account Limitations**: Free accounts have a storage limit. Consider upgrading for more space if needed.
- **Email Verification**: Always verify your email to receive additional free storage space.
- **Regular Backups**: While the plugin is designed to be safe and reliable, always keep backups of your important data.
- **Link Updates**: The plugin updates file links in your notes automatically. Review your notes after bulk uploads to ensure everything looks correct.
- **Internet Connectivity**: Ensure you have a stable internet connection when performing large uploads.
- **File Type Considerations**: Be mindful of the file types you're uploading, especially if you're using the whitelist/blacklist feature.
- **Free Egress Policy**: Our free data transfer (egress) is intended for reasonable use. If your monthly downloads consistently exceed your stored data volume, your account may be subject to limitations. For example, storing 1 TB and downloading up to 1 TB monthly is acceptable, but regularly exceeding this ratio may result in service restrictions.

## Troubleshooting

If you encounter any issues:

1. **Check Your Internet Connection**: Ensure you have a stable connection.
2. **Verify Settings**: Double-check your monitored folders and other settings.
3. **Restart Obsidian**: Sometimes, a simple restart can resolve issues.
4. **Check Console**: Advanced users can check the developer console for any error messages.
5. **Contact Support**: If problems persist, reach out to our support team.

## Support and Contact

If you encounter any issues, have questions, or want to suggest new features, please don't hesitate to reach out:

- **Email**: support@antmight.com
- **GitHub**: Open an issue in our [GitHub repository](#) (Coming soon)

## Upcoming Features

We're constantly working to improve your experience. Here's a sneak peek at some upcoming features:

- Comprehensive backup and migration tools
- Email-based file management interface
- Temporary share links with customizable expiration
- In-file attachment uploading
- Filename blacklist feature
- Improved offline mode functionality

Stay tuned for these exciting updates!

## Feedback and Contributions

We value your input! If you have suggestions for improvements or new features, please let us know. For those interested in contributing to the development of Obsidian Cloud Storage, check out our [contribution guidelines](#) (Coming soon).

Thank you for choosing Obsidian Cloud Storage to enhance your note-taking experience!
