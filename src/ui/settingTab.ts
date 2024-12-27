import { PluginSettingTab, App, Setting } from "obsidian";
import { apiRequestByAccessToken, actionDone, getTempToken, apiRequestByRefreshToken } from "../api/apiRequests";
import { DEFAULT_PASSWORD, USER_MANAGER_BASE_URL } from "../constants";
import CloudStoragePlugin from "../main";
import { ButtonText, ServiceRejectedError, StorageKind } from "../types";
import { UserTypeModal, RegionModal, FolderSuggestModal, ChangePasswordModal, ChangeEmailModal } from "./modals";
import { hashPassword, popNotice, validateEmail, validatePassword } from "../utils/common";
import { getCustomS3Client } from "../uploadManager/obcsS3Client";


export class CloudStorageSettingTab extends PluginSettingTab {
    plugin: CloudStoragePlugin;
    tempPassword: string = '';
    registerButton: HTMLButtonElement;
    resetPasswordButton: HTMLButtonElement;
    verifiedButton: HTMLButtonElement;
    userInfo: {
        email: string;
        isVerified: boolean;
        storageUsed: number;
        storageLimit: number;
        expirationDate: Date | null;
    } = {
            email: '',
            isVerified: false,
            storageUsed: 0,
            storageLimit: 0,
            expirationDate: null
        };

    constructor(app: App, plugin: CloudStoragePlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    async display(): Promise<void> {
        const { containerEl } = this;
        containerEl.empty();

        if (!this.plugin.settings.userInfo.email && !this.plugin.settings.userInfo.refresh_token && this.plugin.settings.accountStatus !== 'existing') {
            this.settingInit(containerEl);
        }

        else {
            this.displayUserAccountSection(containerEl);
            this.displayGeneralSettingsSection(containerEl);
            if (this.plugin.settings.userInfo.refresh_token) {
                this.displaySubscriptionFeaturesSection(containerEl);
            }
            this.displayContactInfo(containerEl);
            this.fetchUserInfo().then(() => {
                this.updateUserAccountSection(containerEl);
            });
        }


    }

    async showUserTypeModal(): Promise<'new' | 'existing' | null> {
        return new Promise((resolve, reject) => {
            const modal = new UserTypeModal(this.app, resolve, reject);
            modal.open();
        });
    }

    // Use async function to wait for user selection
    async showRegionModal(): Promise<string | null> {
        // Return a Promise, resolve after user selection
        return new Promise((resolve, reject) => {
            const modal = new RegionModal(this.app, resolve, reject);
            modal.open();
        });
    }

    async registerAndWaitForRegion() {
        try {
            const selectedRegion = await this.showRegionModal();
            return selectedRegion; // Return the selected region for subsequent logic judgment
        } catch (error) {
            if (error === 'cancelled') {
                console.info('User cancelled the operation.');
                return null; // Return null to indicate cancellation
            } else {
                console.error('An unexpected error occurred:', error);
                throw error; // Throw other exceptions
            }
        }
    }

    async userTypeAndRegion() {
        try {
            const accountStatus = await this.showUserTypeModal();
            this.plugin.settings.accountStatus = accountStatus;
            if (accountStatus === 'new') {
                const selectedRegion = await this.showRegionModal();
                if (selectedRegion) {
                    this.plugin.settings.selectedRegion = selectedRegion;
                    const tempPassword = await hashPassword(DEFAULT_PASSWORD);
                    await this.registerUser("", tempPassword, selectedRegion!, true);
                    this.plugin.settings.accountStatus = "existing";
                }
            }
        }
        finally {
            await this.plugin.saveSettings();
        }
    }



    private async fetchUserInfo(): Promise<void> {
        if (this.plugin.settings.userInfo.access_token && this.plugin.settings.userInfo.access_token) {
            try {
                const response = await apiRequestByAccessToken(this.plugin, 'POST', USER_MANAGER_BASE_URL + '/user_info', {});
                if (response) {
                    this.userInfo = {
                        email: response.email,
                        isVerified: response.is_verified,
                        storageUsed: response.storage_used,
                        storageLimit: response.storage_limit,
                        expirationDate: response.expiration_date
                    };
                }
            } catch (error) {
                console.error('Failed to fetch user info:', error);
                popNotice(true, 'Failed to fetch user information. Please try again later.');
            }
        }
    }

    private updateUserAccountSection(containerEl: HTMLElement) {
        const accountSection = containerEl.querySelector('.setting-section');
        if (accountSection) {
            accountSection.empty();
            this.displayUserAccountSection(accountSection as HTMLElement);
        }
    }



    async openPaymentPage(pay_token: string) {
        const paymentUrl = `https://pay.obcs.top?token=${pay_token}`;
        // const paymentUrl = `http://127.0.0.1:5500/payCheckout/index.html?token=${pay_token}`;
        window.open(paymentUrl, '_blank');
    }

    private settingInit(containerEl: HTMLElement) {
        const initSection = containerEl.createEl('div', { cls: 'setting-section' });
        new Setting(initSection).setName('Initialization').setHeading()
            .addButton(button => button
                .setButtonText(ButtonText.Init)
                .setCta()
                .onClick(async () => {
                    actionDone(this.plugin, ButtonText.Init);
                    await this.userTypeAndRegion();
                    this.display();
                }));
    }

    private displayUserAccountSection(containerEl: HTMLElement) {
        const accountSection = containerEl.createEl('div', { cls: 'setting-section' });
        new Setting(accountSection).setName('User Account').setHeading();

        if (this.plugin.settings.userInfo.refresh_token) {
            // User is logged in
            // Email setting always displayed
            if (this.userInfo.isVerified) {
                const emailSetting = new Setting(accountSection)
                    .setName('Email')
                    .setDesc(this.plugin.settings.userInfo.email);
                emailSetting.descEl.addClass('email-desc');
            }
            else {
                const emailSetting = new Setting(accountSection)
                    .setName('Email')
                    .setDesc(this.plugin.settings.userInfo.email)
                    .addButton(button => button
                        .setButtonText(ButtonText.ChangeEmail)
                        .setCta()
                        .onClick(async () => {

                            const success = await this.changeEmail();
                            if (success) {
                                await this.logoutUser();
                            }
                        }));
                emailSetting.descEl.addClass('email-desc');
            }
            this.displayLoggedInUI(accountSection);
        } else {
            // User is not logged in
            this.displayLoggedOutUI(accountSection);
        }
    }



    private displayCustomStorageSettings(containerEl: HTMLElement) {
        new Setting(containerEl)
            .setName('S3 Endpoint')
            .setDesc('Enter the endpoint URL for your S3-compatible storage.')
            .addText(text => text
                .setPlaceholder('https://s3.amazonaws.com')
                .setValue(this.plugin.settings.customS3Endpoint || '')
                .onChange(async (value) => {
                    this.plugin.settings.customS3Endpoint = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('S3 Region')
            .setDesc('Enter the region for your S3-compatible storage.')
            .addText(text => text
                .setPlaceholder('us-west-2')
                .setValue(this.plugin.settings.customS3Region || '')
                .onChange(async (value) => {
                    this.plugin.settings.customS3Region = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('S3 Access Key')
            .setDesc('Enter your S3 access key.')
            .addText(text => text
                .setPlaceholder('Your S3 access key')
                .setValue(this.plugin.settings.customS3AccessKey || '')
                .onChange(async (value) => {
                    this.plugin.settings.customS3AccessKey = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('S3 Secret Key')
            .setDesc('Enter your S3 secret key.')
            .addText(text => text
                .setPlaceholder('Your S3 secret key')
                .setValue(this.plugin.settings.customS3SecretKey || '')
                .onChange(async (value) => {
                    this.plugin.settings.customS3SecretKey = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('S3 Bucket')
            .setDesc('Enter your S3 bucket name.')
            .addText(text => text
                .setPlaceholder('your-bucket-name')
                .setValue(this.plugin.settings.customS3Bucket || '')
                .onChange(async (value) => {
                    this.plugin.settings.customS3Bucket = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Base URL')
            .setDesc('Enter the base URL for constructing full object URLs.')
            .addText(text => text
                .setPlaceholder('https://your-cdn-url.com/')
                .setValue(this.plugin.settings.customS3BaseUrl || '')
                .onChange(async (value) => {
                    this.plugin.settings.customS3BaseUrl = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Verify S3 Configuration')
            .setDesc('Test the connection to your S3-compatible storage.')
            .addButton(button => button
                .setButtonText(ButtonText.VerifyConfiguration)
                .setCta()
                .onClick(async () => {
                    const loadingNotice = popNotice(true, 'Verifying S3 configuration...', 0);
                    actionDone(this.plugin, ButtonText.VerifyConfiguration);
                    try {
                        const result = await this.verifyS3Configuration();
                        loadingNotice?.hide();
                        if (result) {
                            popNotice(true, 'S3 configuration verified successfully!');
                        }
                    } catch (error) {
                        loadingNotice?.hide();
                        popNotice(true, `Verification failed: ${error.message}`);
                    }
                }));

    }

    private displayGeneralSettingsSection(containerEl: HTMLElement) {
        const generalSection = containerEl.createEl('div', { cls: 'setting-section' });
        new Setting(generalSection).setName('Local').setHeading();

        new Setting(generalSection)
            .setName('Monitored Folders')
            .setDesc('Select folders to monitor. All attachments in these folders will be uploaded.')
            .addButton(button => button
                .setButtonText(ButtonText.AddFolder)
                .setCta()
                .onClick(async () => {
                    this.plugin.settings.monitoredFolders.push('');
                    this.refreshGeneralSettings(generalSection);
                    actionDone(this.plugin, ButtonText.AddFolder);
                }));

        this.plugin.settings.monitoredFolders.forEach((folder, index) => {
            this.createFolderSetting(generalSection, folder, index);
        });

        new Setting(generalSection)
            .setName('Monitor Subfolders')
            .setDesc('When enabled, attachments in all subfolders of the selected folders will be monitored. If disabled, only attachments in the selected folders will be monitored.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.monitorSubfolders || false)
                .onChange(async (value) => {
                    this.plugin.settings.monitorSubfolders = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(generalSection)
            .setName('Auto Upload Attachment')
            .setDesc('If turned off, you can manually upload attachments with one click through the command panel by "Cloud Storage: Upload attachments from the monitored folder" or "Cloud Storage: Upload attachments in current file".')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoUpload)
                .onChange(async (value) => {
                    this.plugin.settings.autoUpload = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(generalSection)
            .setName('Maximum File Size For Automatic Uploads (MB)')
            .setDesc('Set the maximum file size for uploads. Files larger than this will be ignored.Maximum file size upload for non-members is 5MB')
            .addText(text => text
                .setPlaceholder('20')
                .setValue(this.plugin.settings.autoMaxFileSize.toString() || '20')
                .onChange(async (value) => {
                    const size = parseInt(value);
                    this.plugin.settings.autoMaxFileSize = isNaN(size) ? 20 : size;
                    await this.plugin.saveSettings();
                }));

        new Setting(generalSection)
            .setName('More Detailed Notifications')
            .setDesc('Disable this option if you prefer fewer notifications')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.noticeFlag)
                .onChange(async (value) => {
                    this.plugin.settings.noticeFlag = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(generalSection)
            .setName('Local File Handling After Upload')
            .setDesc('Select how to handle local files after successful cloud upload.')
            .addDropdown(dropdown => dropdown
                .addOption('recycle', 'Move to Recycle Bin')
                .addOption('move', 'Move to Custom Folder')
                .setValue(this.plugin.settings.localFileHandling)
                .onChange(async (value: 'move' | 'recycle') => {
                    this.plugin.settings.localFileHandling = value;
                    await this.plugin.saveSettings();
                    this.display(); // Refresh to show/hide the custom folder input
                }));

        if (this.plugin.settings.localFileHandling === 'move') {
            new Setting(generalSection)
                .setName('Custom Move Folder')
                .setDesc('Specify the folder where uploaded attachments will be moved.')
                .addText(text => {
                    text
                        .setPlaceholder('Uploaded_Attachments')
                        .setValue(this.plugin.settings.customMoveFolder)
                        .onChange(async (value) => {
                            this.plugin.settings.customMoveFolder = value;
                            await this.plugin.saveSettings();
                        });
                    // text.inputEl.addEventListener('focus', () => {
                    //     new FolderSuggest(this.app, text.inputEl);
                    // });
                    const browseButtonEl = text.inputEl.parentElement?.createEl('button', {
                        text: 'Browse',
                        cls: 'folder-browse-button',
                    });

                    browseButtonEl?.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        new FolderSuggestModal(this.app, (selectedPath) => {
                            text.setValue(selectedPath);
                            this.plugin.settings.customMoveFolder = selectedPath;
                            this.plugin.saveSettings();
                        }).open();
                    });
                });
        }

        // new Setting(generalSection)
        //     .setName('Secure Link')
        //     .setDesc('If choose to enable, only your Obsidian can open the file. Otherwise, anyone with your link can open your file without restriction.(This feature is currently disabled. )')
        //     .addToggle(toggle => toggle
        //         .setValue(this.plugin.settings.safetyLink || false)
        //         .setDisabled(true)
        //         .onChange(async (value) => {
        //             // this.plugin.settings.safetyLink = value;
        //             // await this.plugin.saveSettings();
        //         }));
    }

    private displaySubscriptionFeaturesSection(containerEl: HTMLElement) {
        const subscriptionSection = containerEl.createEl('div', { cls: 'setting-section subscription-section' });

        new Setting(subscriptionSection).setName('Subscription').setHeading();
        const headerContainer = subscriptionSection.createEl('div', { cls: 'subscription-header' });

        const subscriptionNote = subscriptionSection.createEl('p', {
            text: 'Note: These features are only available to subscribed members.',
            cls: 'custom-setting-item-description'
        });

        new Setting(subscriptionSection)
            .setName('Upgrade to Premium')
            .addButton(button => button
                .setButtonText(ButtonText.Upgrade)
                .setCta()
                .onClick(async () => {
                    if (this.plugin.settings.userInfo.refresh_token) {
                        actionDone(this.plugin, "Subscribe");
                        const pay_token = await getTempToken(this.plugin, "upgrade");
                        if (!pay_token) {
                            console.error("Pay token failed to obtain");
                            return;
                        }
                        this.openPaymentPage(pay_token);
                    } else {
                        popNotice(true, 'Please log in first.');
                    }
                }));

        new Setting(subscriptionSection)
            .setName('File Filter Mode')
            .setDesc('Choose between blacklist and whitelist for file extensions')
            .addDropdown(dropdown => dropdown
                .addOption('blacklist', 'Blacklist')
                .addOption('whitelist', 'Whitelist')
                .setValue(this.plugin.settings.filterMode || 'blacklist')
                .onChange(async (value) => {
                    this.plugin.settings.filterMode = value as 'whitelist' | 'blacklist';
                    await this.plugin.saveSettings();
                }));

        new Setting(subscriptionSection)
            .setName('File Extensions')
            .setDesc('Enter file extensions separated by commas (e.g., jpg,png,pdf)')
            .addText(text => text
                .setPlaceholder('jpg,png,pdf')
                .setValue(this.plugin.settings.fileExtensions || '')
                .onChange(async (value) => {
                    this.plugin.settings.fileExtensions = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(subscriptionSection)
            .setName('Maximum File Size (MB)')
            .setDesc('Set the maximum file size for uploads. Files larger than this will be ignored.Maximum file size upload for non-members is 5MB')
            .addText(text => text
                .setPlaceholder('5')
                .setValue(this.plugin.settings.maxFileSize?.toString() || '')
                .onChange(async (value) => {
                    const size = parseInt(value);
                    this.plugin.settings.maxFileSize = isNaN(size) ? undefined : size;
                    await this.plugin.saveSettings();
                }));

        new Setting(subscriptionSection)
            .setName('Rename Files in Cloud')
            .setDesc('Rename files when uploading to ensure uniqueness and avoid overwriting')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.renameFilesInCloud || false)
                .onChange(async (value) => {
                    this.plugin.settings.renameFilesInCloud = value;
                    await this.plugin.saveSettings();
                }));
    }


    private async verifyS3Configuration(): Promise<boolean> {

        const customS3Client = getCustomS3Client({
            s3Endpoint: this.plugin.settings.customS3Endpoint,
            s3Region: this.plugin.settings.customS3Region,
            s3AccessKeyID: this.plugin.settings.customS3AccessKey,
            s3SecretAccessKey: this.plugin.settings.customS3SecretKey,
            s3BucketName: this.plugin.settings.customS3Bucket
        });
        const errors = { msg: "" };
        const res = await customS3Client!.checkConnect((err: any) => {
            errors.msg = `${err}`;
        });
        if (res) {
            return true;
        }
        else {
            throw new Error('S3 verification failed');
        }
    }



    private async resendVerificationEmail(): Promise<void> {
        if (this.plugin.settings.userInfo.email.endsWith('@obcs.top')) {
            popNotice(true, 'Please update to your personal email address before authenticating.');
            return;
        }
        try {
            const response = await apiRequestByAccessToken(this.plugin, 'POST', USER_MANAGER_BASE_URL + '/resend_verification', {});
            if (response) {
                popNotice(true, 'Verification email sent. Please check your inbox.');
            } else {
                throw new Error('Failed to send verification email');
            }
        } catch (error) {
            console.error('Failed to resend verification email:', error);
            popNotice(true, 'Failed to send verification email.');
        }
    }

    private formatSize(bytes: number): string {
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let size = bytes;
        let unitIndex = 0;
        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex++;
        }
        return `${size.toFixed(2)} ${units[unitIndex]}`;
    }

    private convertUtcToLocalTime(utcTime: Date | null): string {
        if (utcTime === null) {
            return "Membership expired";
        }
        const localDate = new Date(utcTime.toLocaleString('en-US', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
        const year = localDate.getFullYear();
        const month = String(localDate.getMonth() + 1).padStart(2, '0');
        const day = String(localDate.getDate()).padStart(2, '0');

        return `${year}/${month}/${day}`;
    }

    private displayLoggedInUI(containerEl: HTMLElement) {
        new Setting(containerEl)
            .setName('Storage Type')
            .setDesc('Choose between plugin-provided storage or custom S3-compatible storage.')
            .addDropdown(dropdown => dropdown
                .addOption('plugin', 'Plugin-provided Storage')
                .addOption('custom', 'Custom S3-compatible Storage')
                .setValue(this.plugin.settings.storageType || 'plugin')
                .onChange(async (value) => {
                    this.plugin.settings.storageType = value as 'plugin' | 'custom';
                    await this.plugin.saveSettings();
                    // if (value === 'custom') {
                    //     alert('Custom storage are not supported at the moment, coming soon.');
                    // }
                    this.display(); // Refresh the display to show/hide relevant settings
                }));

        if (this.plugin.settings.storageType === 'custom') {
            this.displayCustomStorageSettings(containerEl);
        } else {
            // Display existing plugin storage settings
            this.displayEmailVerificationStatus(containerEl);

            // Membership Information
            new Setting(containerEl)
                .setName('Membership Expiration Date')
                .setDesc(`${this.convertUtcToLocalTime(this.userInfo.expirationDate)}`);

            this.displayStorageUsage(containerEl);


            // Add Storage Management
            new Setting(containerEl)
                .setName('Storage Management')
                .setDesc('Manage your storage space and uploaded files')
                .addButton(button => button
                    .setButtonText(ButtonText.ManageStorage)
                    .onClick(async () => {
                        actionDone(this.plugin, ButtonText.ManageStorage);
                        if (this.plugin.settings.userInfo.refresh_token) {
                            const temp_token = await getTempToken(this.plugin, "manage");
                            if (!temp_token) {
                                console.error("temp token failed to obtain");
                                return;
                            }
                            window.open(`https://files.obcs.top?token=${temp_token}`, '_blank');
                            // window.open(`http://127.0.0.1:5500/objectsManager/index.html?token=${temp_token}`, '_blank');
                        } else {
                            popNotice(true, 'Please log in first.');
                        }
                    }));

            // Add Bulk File Retrieval
            new Setting(containerEl)
                .setName('Bulk File Retrieval')
                .setDesc('Retrieve multiple files at once')
                .addButton(button => button
                    .setButtonText(ButtonText.RetrieveFiles)
                    .onClick(() => {
                        // Implement bulk file retrieval logic here
                        actionDone(this.plugin, ButtonText.RetrieveFiles);
                        popNotice(true, 'Bulk file retrieval feature is not yet implemented.');
                    }));
        }

        new Setting(containerEl)
            .setName('Change Password')
            .setDesc('Change your current password.')
            .addButton(button => button
                .setButtonText(ButtonText.ChangePassword)
                .onClick(() => {
                    actionDone(this.plugin, ButtonText.ChangePassword);
                    if (!this.userInfo.isVerified) {
                        popNotice(true, 'Please verify your email before changing your password to ensure you can recover it later if needed.');
                        return;
                    }
                    new ChangePasswordModal(this.app, this.plugin).open();
                }));

        // Add logout button
        new Setting(containerEl)
            .addButton(button => button
                .setButtonText(ButtonText.Logout)
                .setCta()
                .onClick(() => {
                    actionDone(this.plugin, ButtonText.Logout);
                    this.logoutUser();
                }));
    }

    private displayEmailVerificationStatus(containerEl: HTMLElement) {
        const emailVerificationSetting = new Setting(containerEl)
            .setName('Email Verification Status');

        if (this.userInfo.isVerified) {
            emailVerificationSetting
                .setDesc('Your email has been verified');
            emailVerificationSetting.descEl.addClass('email-verified');
        } else {
            emailVerificationSetting
                .setDesc('Email not verified. Verify your email to receive an additional 512 MB of storage.')
                .addButton(button => button
                    .setButtonText(ButtonText.ResendVerificationEmail)
                    .onClick(async () => {
                        actionDone(this.plugin, ButtonText.ResendVerificationEmail);
                        this.verifiedButton = button.buttonEl;
                        this.verifiedButton.disabled = true;
                        try {
                            await this.resendVerificationEmail();
                        } finally {
                            this.verifiedButton.disabled = false;
                        }
                    }));
            emailVerificationSetting.descEl.addClass('email-not-verified');
        }
    }

    private displayStorageUsage(containerEl: HTMLElement) {
        const storageUsageSetting = new Setting(containerEl)
            .setName('Storage Usage')
            .setDesc(`${this.formatSize(this.userInfo.storageUsed)} / ${this.formatSize(this.userInfo.storageLimit)} used. ⚠️ Storage usage is updated daily.`);
    }

    private async refreshStorageUsage(): Promise<boolean> {
        try {
            const response = await apiRequestByAccessToken(this.plugin, 'POST', USER_MANAGER_BASE_URL + '/refresh_storage_usage', {});
            if (response) {
                this.userInfo.storageUsed = response.storage_used;
                this.userInfo.storageLimit = response.storage_limit;
                return true;
            } else {
                throw new Error('Failed to refresh storage usage');
            }
        } catch (error) {
            console.error('Failed to refresh storage usage:', error);
            popNotice(true, 'Failed to refresh storage usage. Please try again later.');
            return false;
        }
    }

    private displayLoggedOutUI(containerEl: HTMLElement) {
        new Setting(containerEl)
            .setName('Email')
            .setDesc('Your account email')
            .addText(text => text
                .setPlaceholder('Enter your email')
                .setValue(this.plugin.settings.userInfo.email)
                .onChange(async (value) => {
                    this.plugin.settings.userInfo.email = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Password')
            .setDesc(`Enter your password to log in. Default password: ${DEFAULT_PASSWORD}`)
            .addText(text => text
                .setPlaceholder('More than 8 characters')
                .setValue('')
                .onChange(async (value) => {
                    this.tempPassword = await hashPassword(value);
                }));

        new Setting(containerEl)
            .setName('Log in')
            .addButton(button => button
                .setButtonText(ButtonText.Login)
                .onClick(async () => {
                    actionDone(this.plugin, ButtonText.Login);
                    await this.loginUser(this.plugin.settings.userInfo.email, this.tempPassword);
                }));

        new Setting(containerEl)
            .setName('Sign up')
            .addButton(button => button
                .setButtonText(ButtonText.SignUp)
                .setCta()
                .onClick(async () => {
                    actionDone(this.plugin, ButtonText.SignUp);
                    this.registerButton = button.buttonEl;
                    this.registerButton.disabled = true;
                    try {
                        const result = await this.registerAndWaitForRegion();
                        if (result !== null) {
                            await this.registerUser(this.plugin.settings.userInfo.email, this.tempPassword, result);
                        }
                    } catch (error) {
                        popNotice(true, 'Create account failed');
                    } finally {
                        this.registerButton.disabled = false;
                    }
                }));
        new Setting(containerEl)
            .setName('Forgot Password')
            .setDesc('Reset your password if you have forgotten it.')
            .addButton(button => button
                .setButtonText(ButtonText.ResetPassword)
                .onClick(async () => {
                    actionDone(this.plugin, ButtonText.ResetPassword);
                    this.resetPasswordButton = button.buttonEl;
                    this.resetPasswordButton.disabled = true;
                    try {
                        if (!this.plugin.settings.userInfo.email) {
                            popNotice(true, 'Please enter your email address first.');
                            return;
                        }
                        await this.resetPassword(this.plugin.settings.userInfo.email);
                    } finally {
                        this.resetPasswordButton.disabled = false;
                    }
                }));
    }

    private async resetPassword(email: string) {
        try {
            const response = await apiRequestByAccessToken(this.plugin, 'POST', USER_MANAGER_BASE_URL + '/send_reset_mail', { "email": email });

            if (response) {
                popNotice(true, 'Password reset email has been sent. Please check your inbox.');
            }
        } catch (error) {
            console.error('Password reset failed:', error);
            popNotice(true, 'Password reset failed. Please try again later.');
        }
    }

    private createFolderSetting(containerEl: HTMLElement, folder: string, index: number) {
        new Setting(containerEl)
            .setName(`Folder ${index + 1}`)
            .addText(text => {
                text.setPlaceholder('Enter folder path')
                    .setValue(folder)
                    .onChange(async (value) => {
                        this.plugin.settings.monitoredFolders[index] = value;
                        await this.plugin.saveSettings();
                    });

                // text.inputEl.addEventListener('focus', () => {
                //     new FolderSuggest(this.app, text.inputEl);
                // });
                // Add a small browse button next to the input
                const browseButtonEl = text.inputEl.parentElement?.createEl('button', {
                    text: 'Browse',
                    cls: 'folder-browse-button',
                });

                browseButtonEl?.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    new FolderSuggestModal(this.app, (selectedPath) => {
                        text.setValue(selectedPath);
                        this.plugin.settings.monitoredFolders[index] = selectedPath;
                        this.plugin.saveSettings();
                    }).open();
                });
            })
            .addButton(button => button
                .setIcon('x')
                .setTooltip('Remove folder')
                .onClick(async () => {
                    this.plugin.settings.monitoredFolders.splice(index, 1);
                    await this.plugin.saveSettings();
                    const settingSection = containerEl.closest('.setting-section');
                    if (settingSection instanceof HTMLElement) {
                        this.refreshGeneralSettings(settingSection);
                    } else {
                        console.error('Unable to find setting section');
                        this.display(); // Fallback to refreshing the entire display
                    }
                }));
    }

    private refreshGeneralSettings(generalSection: HTMLElement) {
        generalSection.empty();
        this.displayGeneralSettingsSection(generalSection);
    }

    private async registerUser(email: string, password: string, region: string, isAutoRegister: boolean = false) {
        if (!isAutoRegister && (!validateEmail(email) || !validatePassword(password))) {
            popNotice(true, 'Email or password is not compliant.');
            return;
        }

        try {
            const response = await apiRequestByAccessToken(this.plugin, 'POST', USER_MANAGER_BASE_URL + '/register',
                { email, password, region });

            if (response) {
                this.plugin.settings.userInfo.access_token = response.access_token;
                this.plugin.settings.userInfo.refresh_token = response.refresh_token;
                this.plugin.settings.userInfo.email = response.email;
                await this.plugin.saveSettings();
                actionDone(this.plugin, "registerUser", { registerType: isAutoRegister ? "auto" : "manual" });
                this.display();
            }
            else {
                throw new ServiceRejectedError(`Registration request rejected: ${email}`);
            }
        } catch (error) {
            if (!(error instanceof ServiceRejectedError)) {
                popNotice(true, 'Registration failed. Please check your network connection and try again.');
            }
            throw error;
        }
    }

    private async loginUser(email: string, password: string) {
        actionDone(this.plugin, "loginUser");
        try {
            const response = await apiRequestByAccessToken(this.plugin, 'POST', USER_MANAGER_BASE_URL + '/login', { email, password });

            if (response) {
                this.plugin.settings.userInfo.access_token = response.access_token;
                this.plugin.settings.userInfo.refresh_token = response.refresh_token;
                await this.plugin.saveSettings();
                this.display();
                // initS3Client(this.plugin);
            }
        } catch (error) {
            console.error('Login failed:', error);
            popNotice(true, 'Login failed. Please check your network connection and try again.');
        }
    }

    private async logoutUser() {
        actionDone(this.plugin, "logoutUser");
        try {
            await apiRequestByRefreshToken(this.plugin, 'POST', USER_MANAGER_BASE_URL + '/logout', {});
        } catch (error) {
            console.error('Logout failed:', error);
        }

        this.plugin.settings.userInfo.access_token = null;
        this.plugin.settings.userInfo.refresh_token = null;
        await this.plugin.saveSettings();
        this.display();
    }

    private displayContactInfo(containerEl: HTMLElement) {
        const contactSection = containerEl.createEl('div', { cls: 'setting-section' });
        new Setting(contactSection).setName('Contact Us').setHeading();

        const contactInfo = contactSection.createEl('p', {
            text: 'If you have any questions or need support, please contact us at: support@antmight.com',
            cls: 'setting-item-description'
        });
    }

    async changeEmail(): Promise<boolean> {
        try {
            const newEmail = await new Promise<string | null>((resolve) => {
                new ChangeEmailModal(this.app, resolve).open();
            });

            if (!newEmail) return false;
            actionDone(this.plugin, ButtonText.ChangeEmail, { 'newEmail': newEmail });
            const email = newEmail;

            const response = await apiRequestByAccessToken(
                this.plugin,
                'POST',
                USER_MANAGER_BASE_URL + "/change_email",
                { email }
            );

            if (response) {
                popNotice(true, 'Email changed successfully. Please log in with your new email.');
                this.plugin.settings.userInfo.email = response.email;
                await this.plugin.saveSettings();
                return true;
            }
            return false;
        } catch (error) {
            console.error('Email change failed:', error);
            popNotice(true, 'Failed to change email. Please try again later.');
            return false;
        }
    }
}
