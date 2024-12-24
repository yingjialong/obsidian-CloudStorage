import { App, ButtonComponent, FuzzySuggestModal, Modal, Setting, TFolder } from 'obsidian';
import { actionDone, apiRequestByAccessToken } from '../api/apiRequests';
import { USER_MANAGER_BASE_URL } from '../constants';
import CloudStoragePlugin from '../main';
import { ButtonText } from '../types';
import { hashPassword, popNotice, validateEmail, validatePassword } from '../utils/common';

// FolderSuggest class for folder selection popup
export class FolderSuggest {
    constructor(app: App, inputEl: HTMLInputElement) {
        const suggestEl = document.createElement('div');
        suggestEl.classList.add('suggestion-container');

        const folders = app.vault.getAllLoadedFiles().filter(file => file instanceof TFolder).map(folder => folder.path);
        folders.forEach(folder => {
            const folderEl = document.createElement('div');
            folderEl.textContent = folder;
            folderEl.addEventListener('click', () => {
                inputEl.value = folder;
                inputEl.dispatchEvent(new Event('input'));
                suggestEl.remove();
            });
            suggestEl.appendChild(folderEl);
        });

        document.body.appendChild(suggestEl);
        const { left, top } = inputEl.getBoundingClientRect();

        inputEl.addEventListener('blur', () => {
            setTimeout(() => suggestEl.remove(), 200);
        });
    }
}

export class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
    private onChoose: (folder: string) => void;

    constructor(app: App, onChoose: (folder: string) => void) {
        super(app);
        this.onChoose = onChoose;
        // Set a smaller size for the modal
        this.setPlaceholder("Select a folder");
    }

    getItems(): TFolder[] {
        const folderSet = new Set<TFolder>();

        const rootFolder = this.app.vault.getRoot();
        folderSet.add(rootFolder);

        this.app.vault.getAllLoadedFiles().forEach(file => {
            if (file instanceof TFolder && file.path !== '/') {
                folderSet.add(file);
            }
        });

        return Array.from(folderSet).sort((a, b) => {

            if (a.path === '/') return -1;
            if (b.path === '/') return 1;
            return a.path.localeCompare(b.path);
        });
    }

    getItemText(folder: TFolder): string {
        return folder.path || '/';
    }

    onChooseItem(folder: TFolder, evt: MouseEvent | KeyboardEvent): void {
        this.onChoose(folder.path || '/');
    }
}

export class RegionModal extends Modal {
    resolve: (value: string | null) => void;  // Use null to indicate cancellation
    reject: () => void;

    constructor(app: App, resolve: (value: string | null) => void, reject: () => void) {
        super(app);
        this.resolve = resolve;
        this.reject = reject;
    }

    onOpen() {
        const { contentEl } = this;

        // Create a title
        contentEl.createEl('h2', { text: 'Region Selection' });

        // Create a dropdown selection control
        const dropdown = contentEl.createEl('select');

        // Add region groups and options
        this.addRegionOptions(dropdown);

        // Create a prompt message, set to red, small font size
        const description = contentEl.createEl('p', {
            text: 'Please select the region closest to you for optimal upload and download speeds.',
        });
        description.addClass('custom-setting-item-description');

        // Add an OK button and place it in the bottom right corner
        const buttonContainer = contentEl.createDiv({ cls: 'custom-modal-button-container' });

        const okButton = new ButtonComponent(buttonContainer);
        okButton.setButtonText('OK').onClick(() => {
            const selectedRegion = (dropdown as HTMLSelectElement).value;
            this.resolve(selectedRegion);  // Resolve Promise and return the selected region
            this.close();
        });
    }

    addRegionOptions(dropdown: HTMLElement) {
        // Manually create optgroup and option elements and set attributes

        // Asia Pacific
        const asiaGroup = document.createElement('optgroup');
        asiaGroup.label = 'Asia Pacific';
        asiaGroup.appendChild(new Option('Tokyo', 'ap-northeast-1'));
        asiaGroup.appendChild(new Option('Osaka', 'ap-northeast-2'));
        asiaGroup.appendChild(new Option('Singapore', 'ap-southeast-1'));
        asiaGroup.appendChild(new Option('Sydney', 'ap-southeast-2'));
        dropdown.appendChild(asiaGroup);

        // Canada
        const canadaGroup = document.createElement('optgroup');
        canadaGroup.label = 'Canada';
        canadaGroup.appendChild(new Option('Toronto', 'ca-central-1'));
        dropdown.appendChild(canadaGroup);

        // Europe
        const europeGroup = document.createElement('optgroup');
        europeGroup.label = 'Europe';
        europeGroup.appendChild(new Option('Amsterdam', 'eu-central-1'));
        europeGroup.appendChild(new Option('Frankfurt', 'eu-central-2'));
        europeGroup.appendChild(new Option('Milan', 'eu-south-1'));
        europeGroup.appendChild(new Option('London', 'eu-west-1'));
        europeGroup.appendChild(new Option('Paris', 'eu-west-2'));
        dropdown.appendChild(europeGroup);

        // United States
        const usGroup = document.createElement('optgroup');
        usGroup.label = 'United States';
        usGroup.appendChild(new Option('Oregon', 'us-west-1'));
        usGroup.appendChild(new Option('Texas', 'us-central-1'));
        usGroup.appendChild(new Option('N. Virginia', 'us-east-1'));
        usGroup.appendChild(new Option('N. Virginia 2', 'us-east-2'));
        dropdown.appendChild(usGroup);
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();

        // Call reject or resolve(null) to handle cancellation when Modal is closed
        this.resolve(null);  // Use null to indicate user canceled the operation
    }
}

export class ChangePasswordModal extends Modal {
    plugin: CloudStoragePlugin;
    oldPassword: string = '';
    newPassword: string = '';

    constructor(app: App, plugin: CloudStoragePlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;

        contentEl.createEl('h2', { text: 'Change Password' });

        new Setting(contentEl)
            .setName('Current Password')
            .addText(text => text
                .setPlaceholder('Enter current password')
                .onChange(value => this.oldPassword = value));

        new Setting(contentEl)
            .setName('New Password')
            .addText(text => text
                .setPlaceholder('Enter new password')
                .onChange(value => this.newPassword = value));

        new Setting(contentEl)
            .addButton(button => button
                .setButtonText(ButtonText.ChangePassword)
                .setCta()
                .onClick(() => {
                    actionDone(this.plugin, ButtonText.ChangePassword);
                    this.changePassword();
                }));
    }

    async changePassword() {
        if (!validatePassword(this.newPassword)) {
            popNotice(true, 'New password must be at least 8 characters long.');
            return;
        }

        try {
            const response = await apiRequestByAccessToken(this.plugin, 'POST', USER_MANAGER_BASE_URL + "/change_password",
                {
                    'old_password': await hashPassword(this.oldPassword),
                    'new_password': await hashPassword(this.newPassword),
                })

            if (response) {
                popNotice(true, 'Password changed successfully.');
                this.close();
            }
        } catch (error) {
            console.error('Password change failed:', error);
            popNotice(true, 'Password change failed. Please try again later.');
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

export class UserTypeModal extends Modal {
    resolve: (value: 'new' | 'existing' | null) => void;
    reject: () => void;

    constructor(app: App, resolve: (value: 'new' | 'existing' | null) => void, reject: () => void) {
        super(app);
        this.resolve = resolve;
        this.reject = reject;
    }

    onOpen() {
        const { contentEl } = this;

        contentEl.createEl('h2', { text: 'Welcome to Cloud Storage' }).addClass('custom-modal-title');


        const buttonContainer = contentEl.createDiv({ cls: 'custom-modal-botton-usertype-choice' });


        const newUserButton = new ButtonComponent(buttonContainer);
        newUserButton
            .setButtonText('I am a new user')
            .setCta()
            .setClass('custom-modal-button')
            .onClick(() => {
                this.resolve('new');
                this.close();
            });


        const existingUserButton = new ButtonComponent(buttonContainer);
        existingUserButton
            .setButtonText('I have an account.')
            .setCta()
            .setClass('custom-modal-button')
            .onClick(() => {
                this.resolve('existing');
                this.close();
            });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
        this.resolve(null);
    }
}

export class ChangeEmailModal extends Modal {
    private resolve: (value: string | null) => void;
    private newEmail: string = '';

    constructor(app: App, resolve: (value: string | null) => void) {
        super(app);
        this.resolve = resolve;
    }

    onOpen() {
        const { contentEl } = this;

        contentEl.createEl('h2', { text: 'Change Email' });

        // Add warning message
        const warningEl = contentEl.createEl('p', {
            text: 'Warning: After changing your email, you will be automatically logged out and need to log in again.'
        });

        new Setting(contentEl)
            .setName('New Email')
            .addText(text => text
                .setPlaceholder('Enter new email')
                .onChange(value => this.newEmail = value));

        new Setting(contentEl)
            .addButton(button => button
                .setButtonText('Confirm')
                .setCta()
                .onClick(() => {
                    if (!validateEmail(this.newEmail)) {
                        popNotice(true, 'Please enter a valid email address.');
                        return;
                    }
                    this.resolve(this.newEmail);
                    this.close();
                }));
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
        this.resolve(null);
    }
}