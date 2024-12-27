import { Plugin, TFile, TFolder, setIcon } from 'obsidian';
import { popNotice } from "./utils/common";
import { DEFAULT_SETTINGS, VERSION, USER_MANAGER_BASE_URL, DEFAULT_MAX_UPLOAD_SIZE } from './constants';
import { CloudStorageSettings } from './types';
import { apiRequestByAccessToken, actionDone } from './api/apiRequests';
import { Lock, NonBlockingLock } from './utils/Locker';
import { CloudStorageSettingTab } from './ui/settingTab';
import { UploadStatusTracker } from './uploadManager/uploadStatusTracker';
import { FilesUploadManager } from './uploadManager/filesUploadManager';



export default class CloudStoragePlugin extends Plugin {
    settings: CloudStorageSettings;
    // customS3Client: CustomS3 | null = null;
    folderName: string;
    isCloudStorage: boolean = false;
    statusBarItemEl: HTMLElement;
    uploadingFiles: Set<string> = new Set();

    updateLinkLocker: Lock;
    fileUploadLocker: NonBlockingLock;
    platformId: string;
    proccessing: boolean = false;
    
    userType: string = 'register';
    isVerified: boolean = false;
    localFileHandling: 'move' | 'recycle';
    customMoveFolder: string;
    autoUploadRemind: boolean = true;


    async onload() {
        console.info('Assets Upload plugin loaded');

        await this.loadSettings();
        
        if (!this.settings.uuid) {
            
            const timestamp = new Date().getTime();
            const randomNum = Math.floor(Math.random() * 1000000);
            this.settings.uuid = `OBCSID-${timestamp}-${randomNum}`;
            await this.saveSettings();
            actionDone(this, 'init_uuid', {uuid: this.settings.uuid});
        }

        this.settings.safetyLink = false;

        this.updateLinkLocker = new Lock();
        this.fileUploadLocker = new NonBlockingLock();

        this.addCommand({
            id: 'upload-attachments',
            name: 'Upload attachments from the monitored folder',
            callback: () => this.uploadAllAttachments()
        });

        this.addCommand({
            id: 'upload-attachments-in-current-file',
            name: 'Upload attachments in current file',
            checkCallback: (checking: boolean) => {
                // Get the active file
                const activeFile = this.app.workspace.getActiveFile();
                
                // Only enable this command when there is an active file
                if (activeFile) {
                    if (!checking) {
                        this.uploadCurrentFileAttachments(activeFile);
                    }
                    return true;
                }
                return false;
            }
        });

        // Add file menu item
        this.registerEvent(
            this.app.workspace.on('file-menu', (menu, file) => {
                if (file instanceof TFile && file.extension === 'md') {
                    menu.addItem((item) => {
                        item
                            .setTitle('Upload attachments')
                            .setIcon('upload-cloud')
                            .onClick(() => {
                                this.uploadCurrentFileAttachments(file);
                            });
                    });
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('modify', async (file) => {
                if (!this.settings.autoUpload) return;
                
                if (file instanceof TFile && file.extension === 'md') {
                    await this.autoHandleNewAttachments(file);
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('create', async (file) => {
                if (!this.settings.autoUpload) return;
                
                if (file instanceof TFile && file.extension === 'md') {
                    await this.autoHandleNewAttachments(file);
                }
            })
        );

        // Add setting tab
        this.addSettingTab(new CloudStorageSettingTab(this.app, this));

        // Create status bar item
        this.statusBarItemEl = this.addStatusBarItem();
        
        this.statusBarItemEl.empty();
        const iconEl = this.statusBarItemEl.createEl("span", { cls: "status-bar-item-icon" });
        setIcon(iconEl, 'upload-cloud');
        this.statusBarItemEl.createEl("span", { cls: "status-bar-item-segment", text: `\u00A0ready` });
    }


    onunload() {
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }



    async autoHandleNewAttachments(currentPage: TFile) {
        if (!this.settings.userInfo.refresh_token)
        {
            if  (this.autoUploadRemind) 
            {
                popNotice(true,'Please log in first.');
                this.autoUploadRemind = false;
            }
            return;
        }
        if (this.proccessing) {
            // popNotice(true,'Please wait for the previous upload to finish.');
            return;
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
        
            // Retrieve the cache of the current file to find all embedded attachments.
            const fileCache = this.app.metadataCache.getFileCache(currentPage);

        if (fileCache && fileCache.embeds) {
            if (this.fileUploadLocker.acquire())
            {
                this.proccessing = true;
            }
            else
            {
                // popNotice(true,'Please wait for the previous upload to finish.');
                return;
            }

            
            
            try {
                actionDone(this, 'handleNewAttachments');
                // Preliminary Preparation for Uploading Files
                if (!await this.preliminaryforUploading(this))
                {
                    if  (this.autoUploadRemind) 
                    {
                        popNotice(true,"Network error. Please check your internet connection.");
                        this.autoUploadRemind = false;
                    }
                    return;
                }
                const updateStatusTracker = new UploadStatusTracker(this.statusBarItemEl, this.settings.noticeFlag);
                const filesUploadManager = new FilesUploadManager(this, updateStatusTracker);

                const attachmentsToUpload = fileCache.embeds.filter(embed => {
                    const linkedFile = this.app.metadataCache.getFirstLinkpathDest(embed.link, currentPage.path);
                    if (!(linkedFile instanceof TFile) || (linkedFile.extension == 'md')) return false;
                    if (!this.shouldProcessFile(linkedFile)) {
                        if  (this.autoUploadRemind) 
                        {
                            popNotice(true,`Skipping file ${linkedFile.path},Please check your file size or other settings.`);
                            this.autoUploadRemind = false;
                        }
                        
                        return false;
                    }
                    if (this.uploadingFiles.has(linkedFile.path)) return false;
                    if (linkedFile.stat.size > this.settings.autoMaxFileSize * 1024 * 1024) {
                        if  (this.autoUploadRemind) 
                        {
                            popNotice(true,`Skipping file ${linkedFile.path},Please check your file size or other settings.`);
                            this.autoUploadRemind = false;
                        }
                        return false;
                    }
                    return true;
                });

                const uploadFiles: TFile[] = [];
                attachmentsToUpload.map(async embed => {
                    const linkedFile = this.app.metadataCache.getFirstLinkpathDest(embed.link, currentPage.path);
                    if (linkedFile instanceof TFile  && linkedFile.extension !== 'md') {
                        this.uploadingFiles.add(linkedFile.path);
                        uploadFiles.push(linkedFile);
                    }
                });

                try {
                    await filesUploadManager.uploadFiles(uploadFiles, currentPage);
                } 
                finally {
                    this.uploadingFiles.clear();
                }
            } catch (error) {
                console.error("Error uploading attachments:", error);
            }finally {
                // this.initStatusBarItemEl(this.statusBarItemEl);
                this.fileUploadLocker.release();
                this.proccessing = false;
            }
        }
        
    }

    async uploadCurrentFileAttachments(currentPage: TFile) {
        if (!this.settings.userInfo.refresh_token) {
            popNotice(true,'Please log in first.');
            return;
        }
        
        if (this.proccessing) {
            popNotice(true,'Please wait until the current upload is complete.');
            return;
        }
        if (this.fileUploadLocker.acquire())
        {
            this.proccessing = true;
        }
        else
        {
            popNotice(true,'Please wait until the current upload is complete.');
            return;
        }
        

        try {
            actionDone(this, 'uploadCurrentFileAttachments');

            // Preliminary Preparation for Uploading Files
            if (!await this.preliminaryforUploading(this))
            {
                popNotice(true,"Network error. Please check your internet connection.");
                return;
            }
            const updateStatusTracker = new UploadStatusTracker(this.statusBarItemEl, this.settings.noticeFlag);
            const filesUploadManager = new FilesUploadManager(this, updateStatusTracker);
            const uploadFiles: TFile[] = [];

            // Retrieve the cache of the current file to find all embedded attachments.
            const fileCache = this.app.metadataCache.getFileCache(currentPage);

            if (fileCache && fileCache.embeds) {
                for (const embed of fileCache.embeds) {
                    // Retrieve the file corresponding to the link.
                    const linkedFile = this.app.metadataCache.getFirstLinkpathDest(embed.link, currentPage.path);
                    
                    if (linkedFile instanceof TFile && linkedFile.extension !== 'md') {
                        // Check if the file should be processed.
                        if (this.shouldProcessFile(linkedFile)) {
                            uploadFiles.push(linkedFile);
                        } else {
                            await updateStatusTracker.updateSkippedFileCount();
                            popNotice(this.settings.noticeFlag,`Skipping file ${linkedFile.path},Please check your file size or other settings.`)
                        }
                    }
                }
            }

            // Wait for all uploads to complete
            await filesUploadManager.uploadFiles(uploadFiles, currentPage);
            popNotice(true,`Upload complete: ${updateStatusTracker.uploadedSuccessFileCount} successful, ${updateStatusTracker.uploadedErrorFileCount} failed, ${updateStatusTracker.skipUploadCount} skipped`)
        } catch (error) {
            console.error("Error uploading attachments:", error);
        } finally {
            // this.initStatusBarItemEl(this.statusBarItemEl);
            this.fileUploadLocker.release();
            this.proccessing = false;
        }
    }

    async uploadAllAttachments() {
        if (!this.settings.userInfo.refresh_token) {
            popNotice(true,'Please log in first.');
            return;
        }

        if (this.proccessing) {
            popNotice(true,'Please wait until the current upload is complete.');
            return;
        }

        // Get "Monitored Folders" from plugin settings
        const monitoredFolders = this.settings.monitoredFolders; // Assume this information is stored in settings
        const allMonitoredFolders: string[] = [];

        for (const folderPath of monitoredFolders) {
            allMonitoredFolders.push(folderPath);
            
            if (this.settings.monitorSubfolders) {
                const folder = this.app.vault.getAbstractFileByPath(folderPath);
                if (folder instanceof TFolder) {
                    const subFolders = getAllSubfolders(folder);
                    allMonitoredFolders.push(...subFolders);
                }
            }
        }

        // Helper function to get all subfolders
        function getAllSubfolders(folder: TFolder): string[] {
            let subFolders: string[] = [];
            for (const child of folder.children) {
                if (child instanceof TFolder) {
                    subFolders.push(child.path);
                    subFolders = subFolders.concat(getAllSubfolders(child));
                }
            }
            return subFolders;
        }
        const uniqueMonitoredFolders = [...new Set(allMonitoredFolders)];

        if (uniqueMonitoredFolders.length === 0) {
            popNotice(true,'No monitored folders found. Please add monitored folders first.');
            actionDone(this, 'uploadAllAttachments_nomonitored');
            return;
        }
        
        if (this.fileUploadLocker.acquire())
        {
            this.proccessing = true;
        }
        else
        {
            popNotice(true,'Please wait until the current upload is complete.');
            return;
        }
        

        try{
            actionDone(this, 'uploadAllAttachments_ok');
            // Preliminary Preparation for Uploading Files
            if (!await this.preliminaryforUploading(this))
            {
                popNotice(true,"Network error. Please check your internet connection.");
                return;
            }
            const updateStatusTracker = new UploadStatusTracker(this.statusBarItemEl, this.settings.noticeFlag);
            const filesUploadManager = new FilesUploadManager(this, updateStatusTracker);

            // Iterate through all monitored folders
            for (const folderPath of uniqueMonitoredFolders) {
                const folder = this.app.vault.getAbstractFileByPath(folderPath);
                console.info(`Scanning folder: ${folderPath}`);
                if (folder instanceof TFolder) {
                    await this.scanFolder(folder, filesUploadManager, updateStatusTracker);
                }
            }
            popNotice(true,`Upload complete: ${updateStatusTracker.uploadedSuccessFileCount} successful, ${updateStatusTracker.uploadedErrorFileCount} failed, ${updateStatusTracker.skipUploadCount} skipped`)
        }
        finally {
            // this.initStatusBarItemEl(this.statusBarItemEl);
            this.fileUploadLocker.release();
            this.proccessing = false;
        }
        
    }

    async scanFolder(folder: TFolder, fileUploadManager: FilesUploadManager, updateStatusTracker: UploadStatusTracker) {
        const filesToProcess = [...folder.children];
        const uploadFiles: TFile[] = [];
        for (const file of filesToProcess) {
            if (file instanceof TFile && file.extension !== 'md') {
                if (this.shouldProcessFile(file)) {
                    uploadFiles.push(file);
                }
                else {
                    await updateStatusTracker.updateSkippedFileCount()
                    popNotice(this.settings.noticeFlag,`Skipping file ${file.path},Please check your file size or other settings.`)
                }
            }
        }
        await fileUploadManager.uploadFiles(uploadFiles);
    }

    private async preliminaryforUploading(plugin: CloudStoragePlugin): Promise<boolean> {
        if (plugin.settings.storageType === "custom")
            actionDone(plugin, 'upload_custom');
        else
            actionDone(plugin, 'upload_plugin');
        const storageType = this.settings.storageType;
        const response = await apiRequestByAccessToken(this, 'POST', USER_MANAGER_BASE_URL + "/get_user_simple_info", {"storageType":storageType,"version":VERSION});
        if (response) {
            this.userType = response.user_type;
            this.folderName = response.folder_name;
            this.isVerified = response.is_verified;
        }
        else
        {
            this.userType = "";
            this.folderName = "";
            this.isVerified = false;
            return false;
        }
        
        return true;
    }

    private shouldProcessFile(file: TFile): boolean {
        if(this.userType === "")
            return false;

        if (this.userType === 'register') {
            if (file.stat.size > DEFAULT_MAX_UPLOAD_SIZE) {
                return false;
            }
        }
        else {
            // Check file size
            const maxSizeMB = this.settings.maxFileSize;
            if (maxSizeMB && file.stat.size > maxSizeMB * 1024 * 1024) {
                return false;
            }

            // Check file extension
            const fileExtensions = this.settings.fileExtensions.split(',').map(ext => ext.trim().toLowerCase());
            const fileExtension = file.extension.toLowerCase();

            if (this.settings.filterMode === 'whitelist') {
                if (!fileExtensions.includes(fileExtension)) {
                    return false;
                }
            } else if (this.settings.filterMode === 'blacklist') {
                if (fileExtension === "") {
                    return true;
                }
                if (fileExtensions.includes(fileExtension)) {
                    return false;
                }
            }
        }

        return true;
    }

}