import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, requestUrl, TFile, TFolder, setIcon, ButtonComponent, RequestUrlResponse, TAbstractFile, normalizePath,moment } from 'obsidian';
import { S3Client, AbortMultipartUploadCommand, ListPartsCommand, ListMultipartUploadsCommand } from "@aws-sdk/client-s3";
import CryptoJS from 'crypto-js';

// Configuration
const PART_MAX_RETRIES = 3;
const DEFAULT_MAX_UPLOAD_SIZE = 5 * 1024 * 1024;
const USER_MANAGER_BASE_URL = 'https://obcs-api.obcs.top/api';
//const USER_MANAGER_BASE_URL = 'http://127.0.0.1:5001/api';

interface UploadProgress {
    uploadId: string;
    key: string;  // S3 file key
    localPath: string;  // Local Obsidian file path
    parts: { PartNumber: number; ETag: string }[];
    bytesUploaded: number;
    fileMD5: string;
}

interface UserInfo {
    email: string;
    token: string | null;
}

interface MyPluginSettings {
    monitoredFolders: string[];
    uploadProgress: Record<string, UploadProgress>;
    userInfo: UserInfo;
    filterMode: 'whitelist' | 'blacklist';
    fileExtensions: string;
    maxFileSize?: number;
    renameFilesInCloud: boolean;
    storageType: 'plugin' | 'custom';
    customS3Endpoint: string;
    customS3Region: string;
    customS3AccessKey: string;
    customS3SecretKey: string;
    customS3Bucket: string;
    customS3BaseUrl: string;
    localFileHandling: 'move' | 'recycle';
    customMoveFolder: string;
    
}

const DEFAULT_SETTINGS: MyPluginSettings = {
    monitoredFolders: [],
    uploadProgress: {},
    userInfo: {
        email: '',
        token: null
    },
    filterMode: 'blacklist',
    fileExtensions: "",
    maxFileSize: undefined,
    renameFilesInCloud: false,
    storageType: 'plugin',
    customS3Endpoint: "",
    customS3Region: "",
    customS3AccessKey: "",
    customS3SecretKey: "",
    customS3Bucket: "",
    customS3BaseUrl: "",
    localFileHandling: 'recycle',
    customMoveFolder: 'Uploaded_Attachments'
};

const enum UploadStatus {
    Seccess, // upload seccessfully
    StorageLimit, // upload skipped due to storage limit
    PerFileMaxLimit // upload skipped due to per file limit
}

export default class MyPlugin extends Plugin {
    settings: MyPluginSettings;
    s3Client_aws: S3Client | null = null;
    customS3Client: S3Client | null = null;
    bucket_id: string;
    bucket: string;
    isCloudStorage: boolean = false;
    statusBarItemEl: HTMLElement;
    skipUploadCount: number = 0; // Number of files skipped
    uploadingFileCount: number = 0; // Total number of files to be uploaded
    uploadedFileCount: number = 0; // Number of files already uploaded
    uploadedErrorFileCount: number = 0; // Number of files that failed to upload
    uploadedSuccessFileCount: number = 0; // Number of files successfully uploaded
    uploadedS3FileSize: number = 0; // Total size of files already uploaded to S3
    uploadingFileSize: number = 0; // Total size of files to be uploaded
    private timer: NodeJS.Timeout | null = null;
    countLocker: Lock;
    updateLinkLocker: Lock;
    private uploadProgress: Record<string, UploadProgress> = {};
    platformId: string;
    proccessing: boolean = false;
    proccessNotice: Notice | null = null;
    userType: string = 'register';
    isVerified: boolean = false;
    localFileHandling: 'move' | 'recycle';
    customMoveFolder: string;

    async onload() {
        console.info('Assets Upload plugin loaded');

        await this.loadSettings();

        this.countLocker = new Lock();
        this.updateLinkLocker = new Lock();

        // await initS3Client(this);

        this.addCommand({
            id: 'upload-all-attachments',
            name: 'Upload all attachments',
            callback: () => this.uploadAllAttachments()
        });

        // this.addCommand({
        //     id: 'cleanup-Obsolete-Progress',
        //     name: 'Cleanup Obsolete Progress',
        //     callback: () => this.cleanupObsoleteProgress()
        // });

        // this.addCommand({
        //     id: 'list-In-Progress-Uploadss',
        //     name: 'List In Progress Uploads',
        //     callback: () => this.listInProgressUploads()
        // });

        // Add setting tab
        this.addSettingTab(new DefaultSettingTab(this.app, this));

        // Create status bar item
        this.statusBarItemEl = this.addStatusBarItem();
        this.updateStatusBar();
    }

    onunload() {
        // Cleanup work when the plugin is unloaded
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
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
            return selectedRegion;  // Return the selected region for subsequent logic judgment
        } catch (error) {
            if (error === 'cancelled') {
                console.info('User cancelled the operation.');
                return null;  // Return null to indicate cancellation
            } else {
                console.error('An unexpected error occurred:', error);
                throw error;  // Throw other exceptions
            }
        }
    }

    async requestUploadStart(file_hash: string, file_name: string, total_bytes: number) {
        const response = await apiRequest(this, 'POST',
            '/init_upload',
            { file_hash, file_name, total_bytes }
        );
        return response;
    }

    async requestCompletedUpload(upload_id: string) {
        const response = await apiRequest(this, 'POST',
            '/complete_upload',
            {
                upload_id: upload_id
            }
        );
        return response;
    }

    async requestNextUpload(upload_id: string, part_number: number, etag: string | null, uploaded_bytes: number) {
        const response = await apiRequest(this, 'POST',
            '/upload_part',
            {
                upload_id: upload_id,
                part_number: part_number,
                etag: etag,
                uploaded_bytes: uploaded_bytes
            }
        );
        return response;
    }

    async uploadFileWithResume(file: TFile, key: string): Promise<[number,string, string] | null> {
        let response: any;

        const fileMD5 = await this.calculateMD5(file);
        response = await this.requestUploadStart(fileMD5, key, file.stat.size)
        if (response === null) {
            console.error('Failed to request upload start: ', file.name);
            throw new Error(`Failed to upload part ${file.name}`);
        }

        if (response.upload_status == 'completed') {
            await this.updateUploadedFileSize(file.stat.size);
            console.info(`File ${key} already uploaded response: ${response}`);

            const fileKey = response.key;
            const bucket_id = response.bucket_id;

            return [UploadStatus.Seccess,fileKey, bucket_id];
        }

        if (response.upload_status == 'storagelimit') {
            await this.updateUploadedFileSize(file.stat.size);
            return [UploadStatus.StorageLimit,"", ""];
        }
        if (response.upload_status == 'perfilemaxlimit') {
            await this.updateUploadedFileSize(file.stat.size);
            return [UploadStatus.PerFileMaxLimit,"", ""];
        }

        let uploadId = response.upload_id;
        let partNumber = response.part_number;
        let url = response.url;
        let CHUNK_SIZE = response.part_size;
        let uploadedBytes = response.uploaded_bytes;

        const fileContent = await this.app.vault.adapter.readBinary(file.path);
        try {
            while (uploadedBytes < file.stat.size) {
                const start = uploadedBytes;
                const end = Math.min(start + CHUNK_SIZE, file.stat.size);
                const chunkSize = end - start;

                const chunk = fileContent.slice(start, end);

                let retries = 0;
                let etag = null;
                while (retries < PART_MAX_RETRIES) {
                    try {
                        // Upload chunk
                        let uploadResponse: RequestUrlResponse;
                        try {
                            const up_start = performance.now();
                            uploadResponse = await requestUrl({
                                url: url,
                                method: 'PUT',
                                body: chunk,
                                headers: {
                                    'Content-Type': 'application/octet-stream'
                                }
                            });

                        } catch (error) {
                            console.error(`Failed to upload part(requestUrl),file:${key},partNumber:${partNumber},${error}}`);
                            throw new Error(`Failed to upload part(catch),file:${key},partNumber:${partNumber}`);
                        }
                        if (uploadResponse.status !== 200) {
                            console.error(`Failed to upload part,file:${key},partNumber:${partNumber}`);
                            throw new Error(`Failed to upload part,file:${key},partNumber:${partNumber}`);
                        }


                        etag = uploadResponse.headers['etag'];
                        if (etag) {
                            console.debug(`Part ${partNumber} uploaded successfully. Progress: ${((end / file.stat.size) * 100).toFixed(2)}%`);
                            break;
                        } else {
                            throw new Error(`Failed to upload part ${partNumber}`);
                        }
                    } catch (error) {
                        retries++;
                        if (retries >= PART_MAX_RETRIES) {
                            console.error(`Failed to upload part ${partNumber} after ${PART_MAX_RETRIES} retries. ${error}`);
                            throw error;
                        }
                        else {
                            console.warn(`Error uploading part ${partNumber}. Retrying... (${retries + 1}/${PART_MAX_RETRIES})`);
                        }
                        await new Promise(resolve => setTimeout(resolve, 1000 * retries)); // Exponential backoff
                    }
                }

                // Notify server of successful part upload
                response = await this.requestNextUpload(uploadId, partNumber, etag, end);
                if (response == null) {
                    console.error(`Failed to notify server of successful part upload,file:${key},partNumber:${partNumber}`);
                    throw new Error(`Failed to upload part ${file.name}`);
                }

                url = response.url;
                partNumber = response.part_number;
                uploadedBytes = response.uploaded_bytes;
                
                await this.updateUploadedFileSize(chunkSize); // upload seccessed, update the uploaded file size

            }

            // Complete the multipart upload
            response = await this.requestCompletedUpload(uploadId)
            if (response == null) {
                console.error(`Failed to complete multipart upload,file:${key}`);
                throw new Error(`Failed to upload part ${file.name}`);
            }
            const fileKey = key;
            const bucket_id = response.bucket_id;
            return [UploadStatus.Seccess,fileKey, bucket_id];

        } catch (error) {
            console.error("Error during file upload:", error);
            // Keep the progress saved so we can resume later
            throw error;
        }
    }

    async calculateMD5(file: TFile): Promise<string> {

        // Read the entire file as Blob
        const fileBlob = new Blob([await this.app.vault.readBinary(file)]);

        const md5 = CryptoJS.algo.MD5.create();
        const chunkSize = 64 * 1024 * 1024; // 64MB, adjust as needed
        const fileSize = fileBlob.size;
        let notice: Notice | null = null;
        if (fileSize > chunkSize * 3){
            notice = new Notice(`Calculating MD5 for ${file.name}`,0);
        }

        for (let offset = 0; offset < fileSize; offset += chunkSize) {
            // Use Blob.slice() to get the current chunk of the file
            const chunk = fileBlob.slice(offset, Math.min(offset + chunkSize, fileSize));            

            // Convert Blob chunk to ArrayBuffer
            const chunkBuffer = await this.readBlobAsArrayBuffer(chunk);

            // Convert ArrayBuffer to CryptoJS supported WordArray
            const wordArray = CryptoJS.lib.WordArray.create(chunkBuffer as any);

            // Update MD5 calculation
            md5.update(wordArray);
            if (notice){
                notice.setMessage(`Calculating MD5 for ${file.name} - ${Math.round((offset / fileSize) * 100)}%`);
            }
        }

        // Calculate the final MD5 hash
        const md5Hash = md5.finalize().toString();
        if (notice){
            notice.hide();
        }

        return md5Hash;
    }

    // Helper method: Read Blob as ArrayBuffer
    private async readBlobAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                if (reader.result) {
                    resolve(reader.result as ArrayBuffer);
                } else {
                    reject(new Error("Failed to read blob as ArrayBuffer"));
                }
            };
            reader.onerror = () => reject(reader.error);
            reader.readAsArrayBuffer(blob);
        });
    }

    async updateSkipedFileCount() {
        await this.countLocker.acquire()
        try {
            this.skipUploadCount++;
            await this.updateStatusBar()
        }
        finally {
            this.countLocker.release();
        }
    }
    async updateUploadedErrorFileInfo() {
        await this.countLocker.acquire()
        try {
            this.uploadedErrorFileCount++;
        }
        finally {
            this.countLocker.release();
        }
    }

    async updateUploadedSuccessFileInfo() {
        await this.countLocker.acquire()
        try {
            this.uploadedSuccessFileCount++;
        }
        finally {
            this.countLocker.release();
        }
    }

    async updateUploadingFileCount() {
        await this.countLocker.acquire()
        try {
            this.uploadingFileCount++;
            await this.updateStatusBar();
        }
        finally {
            this.countLocker.release();
        }
    }

    async updateUploadingFileSize(fileSize: number) {
        await this.countLocker.acquire()
        try {
            this.uploadingFileSize += fileSize;
            await this.updateStatusBar();
        }
        finally {
            this.countLocker.release();
        }
    }

    async updateUploadedFileSize(uploadedS3FileSize: number) {
        await this.countLocker.acquire()
        try {
            this.uploadedS3FileSize += uploadedS3FileSize;
            await this.updateStatusBar();
        }
        finally {
            this.countLocker.release();
        }
    }

    async updateUploadedFileCount() {
        await this.countLocker.acquire()
        try {
            this.uploadedFileCount++;
            await this.updateStatusBar();
        }
        finally {
            this.countLocker.release();
        }
    }

    async updateStatusBar() {
        this.statusBarItemEl.empty(); // Clear existing content
        const iconEl = this.statusBarItemEl.createEl("span", { cls: "status-bar-item-icon" });
        setIcon(iconEl, 'file-up');
        if (this.proccessing) {
            // Calculate upload progress percentage, floor it
            let percent = Math.floor(this.uploadedS3FileSize / this.uploadingFileSize * 100);
            if (this.uploadingFileCount === this.uploadedFileCount || percent > 100) percent = 100;
            const textEl = this.statusBarItemEl.createEl("span", { cls: "status-bar-item-segment", text: `Uploading ${percent}%` });
            if (this.proccessNotice) {
                this.proccessNotice.setMessage(`Uploading ${this.uploadedFileCount} of ${this.uploadingFileCount} files... [${percent}% done][${this.skipUploadCount} files skipped]`);
            } // Uploading [x] of [y] files... ([z]% done)
            else {
                this.proccessNotice = new Notice(`Uploading ${this.uploadedFileCount} of ${this.uploadingFileCount} files... [${percent}% done][${this.skipUploadCount} files skipped]`,0);
            }
        }
    }

    /**
     * Generate new file name
     * @param originalName Original file name
     * @returns New file name
     */
    generateNewFileName(originalName: string): string {
        if (this.userType === "register" || this.settings.renameFilesInCloud === false) {
            return originalName;
        }
        //let urlFriendlyName = encodeURIComponent(originalName);
        let urlFriendlyName = originalName.replace(/\s/gi, '_');
        const timestamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
        const randomSuffix = Math.random().toString(36).substring(2, 6);
        const extensionIndex = urlFriendlyName.lastIndexOf('.');
        const baseName = urlFriendlyName.substring(0, extensionIndex);
        const extension = urlFriendlyName.substring(extensionIndex);
        return `${baseName}_${timestamp}_${randomSuffix}${extension}`;
    }

    /**
     * Update references in documents
     */
    async updateFileReferencesForS3(originalName: string, fileKey: string, fileExtension: string, bucketid: string) {
        const allMarkdownFiles = this.app.vault.getMarkdownFiles();
        let findFlag = false;
        let updated = false;
        for (const file of allMarkdownFiles) {
            let skipFlag = true;
            if (file) {
                const cache = this.app.metadataCache.getFileCache(file);
                if (cache && cache.embeds) {
                    for (const embed of cache.embeds) {
                        if (embed.link === originalName) {
                            findFlag = true;
                            skipFlag = false;
                            break;
                        }
                    }
                }
                if (skipFlag) {
                    continue;
                }
                let imageFlag = '';
                if (['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif', 'bmp', 'tiff'].includes(fileExtension)) {
                    imageFlag = '!';
                }
                await this.updateLinkLocker.acquire(originalName);
                try {
                    const url = encodeURI(`https://link.obcs.top/file/${bucketid}/${fileKey}`)
                    const content = await this.app.vault.read(file);
                    const replace_originalName = originalName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    let newContent = content;
                    newContent = newContent.replace(
                        new RegExp(`!?\\[\\[(.*?\\/)?${replace_originalName}\\s*?(\\|.*?)?\\]\\]`, 'g'),
                        imageFlag + `[${originalName}](${url})`
                    );

                    const encode_file_name = encodeURIComponent(originalName);
                    const replace_originalName2 = encode_file_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    newContent = newContent.replace(
                        new RegExp(`!?\\[.*\\]\\((?!http)(.*?\\/)?${replace_originalName2}\\s*?(\\|.*?)?\\)`, 'g'),
                        imageFlag + `[${originalName}](${url})`
                    );

                    if (content !== newContent) {
                        await this.app.vault.modify(file, newContent);
                        updated = true;
                        const testcontent = await this.app.vault.read(file);
                    }
                } finally {
                    this.updateLinkLocker.release(originalName);
                }
            }
        }
        if (!findFlag) console.debug(`not found ${originalName} content`);

        return updated;
    }

    async updateFileReferencesSecondary(originalName: string, fileKey: string, fileExtension: string, bucketid: string) {
        console.debug(`updateFileReferencesSecondary ${originalName}`);
        const allMarkdownFiles = this.app.vault.getMarkdownFiles();
        let updated = false;
        for (const file of allMarkdownFiles) {
            if (file) {
                let imageFlag = '';
                if (['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif', 'bmp', 'tiff'].includes(fileExtension)) {
                    imageFlag = '!';
                }
                await this.updateLinkLocker.acquire(originalName);
                try {
                    const url = encodeURI(`https://link.obcs.top/file/${bucketid}/${fileKey}`)
                    const content = await this.app.vault.read(file);
                    const replace_originalName = originalName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    let newContent = content;
                    newContent = newContent.replace(
                        new RegExp(`!?\\[\\[(.*?\\/)?${replace_originalName}\\s*?(\\|.*?)?\\]\\]`, 'g'),
                        imageFlag + `[${originalName}](${url})`
                    );

                    const encode_file_name = encodeURIComponent(originalName);
                    const replace_originalName2 = encode_file_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    newContent = newContent.replace(
                        new RegExp(`!?\\[.*\\]\\((?!http)(.*?\\/)?${replace_originalName2}\\s*?(\\|.*?)?\\)`, 'g'),
                        imageFlag + `[${originalName}](${url})`
                    );
                    if (content !== newContent) {
                        await this.app.vault.modify(file, newContent);
                        updated = true;
                    }
                } finally {
                    this.updateLinkLocker.release(originalName);
                }
            }
        }

        return updated;
    }

    async uploadAllAttachments() {
        if (this.settings.storageType === "custom") {
            new Notice("Custom storage are not supported at the moment, coming soon.");
            return;
        }

        if (this.proccessing) {
            new Notice("Please wait for the previous upload to finish.");
            return;
        }

        // Get "Monitored Folders" from plugin settings
        const monitoredFolders = this.settings.monitoredFolders; // Assume this information is stored in settings
        if (monitoredFolders.length === 0) {
            new Notice("No monitored folders found.Please add monitored folders first.");
            return;
        }

        const response = await apiRequest(this, 'POST', "/get_user_type", {});
        if (response) {
            this.userType = response.user_type;
            this.isVerified = response.is_verified;
        }

        this.proccessing = true;
        this.proccessNotice = null;

        // Initialize upload counters
        this.uploadingFileCount = 0; // Total number of files to be uploaded
        this.uploadedFileCount = 0; // Number of files already uploaded
        this.uploadedS3FileSize = 0; // Total size of files already uploaded
        this.uploadingFileSize = 0; // Total size of files to be uploaded
        this.uploadedErrorFileCount = 0;
        this.uploadedSuccessFileCount = 0;

        
        const allFilePromises: Promise<void>[] = [];
        // Iterate through all monitored folders
        for (const folderPath of monitoredFolders) {
            const folder = this.app.vault.getAbstractFileByPath(folderPath);
            console.info(`Scanning folder: ${folderPath}`);
            if (folder instanceof TFolder) {
                await this.scanFolder(folder, allFilePromises);
            }
        }
        await Promise.all(allFilePromises);
        new Notice(`Storage completed: success ${this.uploadedSuccessFileCount}, failure ${this.uploadedErrorFileCount}, skiped ${this.skipUploadCount}`);
        this.statusBarItemEl.empty();
        const iconEl = this.statusBarItemEl.createEl("span", { cls: "status-bar-item-icon" });
        setIcon(iconEl, 'file-up');
        this.proccessing = false;
    }

    async scanFolder(folder: TFolder, allFilePromises: Promise<void>[]) {
        const filesToProcess = [...folder.children];
        for (const file of filesToProcess) {
            if (file instanceof TFile && file.extension !== 'md') {
                if (this.shouldProcessFile(file)) {
                    const filePromise = this.processFile(file);
                    allFilePromises.push(filePromise);
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
                else {
                    await this.updateSkipedFileCount()
                    new Notice(`Skipping file ${file.path}`);
                }
            }
        }
    }

    private shouldProcessFile(file: TFile): boolean {
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

    // Function to generate a new filename with timestamp
    private getUniqueFilename(originalName: string): string {
        const timestamp = moment().format('YYYYMMDDHHmmss');
        const extensionIndex = originalName.lastIndexOf('.');
        if (extensionIndex === -1) {
            return `${originalName}_${timestamp}`;
        } else {
            const nameWithoutExtension = originalName.slice(0, extensionIndex);
            const extension = originalName.slice(extensionIndex);
            return `${nameWithoutExtension}_${timestamp}${extension}`;
        }
    }
    // Updated function to handle file after upload
    async handleLocalFile(file: TAbstractFile) {
        if (!(file instanceof TFile)) {
            console.error('The provided abstract file is not a file');
            return;
        }

        if (this.settings.localFileHandling === 'recycle') {
        // Move file to recycle bin
        await this.app.vault.trash(file, true);
        } else {
            // Move file to custom folder
            const targetFolderPath = this.settings.customMoveFolder || 'Uploaded_Attachments';
            let targetFolder = this.app.vault.getAbstractFileByPath(targetFolderPath);
            
            // Ensure the target folder exists
            if (!targetFolder) {
                targetFolder = await this.app.vault.createFolder(targetFolderPath);
            }

            if (targetFolder instanceof TFolder) {
                let newFileName = file.name;
                let newPath = normalizePath(`${targetFolder.path}/${file.name}`);
                if (await this.app.vault.adapter.exists(newPath)) {
                    newFileName = this.getUniqueFilename(file.name);
                    newPath = normalizePath(`${targetFolder.path}/${newFileName}`);
                }
                await this.app.fileManager.renameFile(file, newPath);
            } else {
                console.error(`Target is not a folder: ${targetFolderPath}`);
            }
        }
    }

    async processFile(file: TFile) {
        if (!this.settings.userInfo.token) {
            new Notice('Please relogin');
            return;
        }

        const basePath = (this.app.vault.adapter as any).basePath;
        const filePath = `${basePath}/${file.path}`;
        const newFileName = this.generateNewFileName(file.name);
        const maxRetries = 3;  // Maximum number of retries
        const retryDelay = 5000;  // Initial retry delay (milliseconds)

        const fileExtension = file.extension.toLowerCase();
        // if (['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif', 'bmp', 'tiff', 'pdf', ].includes(fileExtension)) {
        if (true) {

            await this.updateUploadingFileCount();
            await this.updateUploadingFileSize(file.stat.size);

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const result = await this.uploadFileWithResume(file, newFileName);
                    if (result && result[0] === UploadStatus.Seccess) {
                        await this.updateUploadedSuccessFileInfo();
                        await this.updateUploadedFileCount();
                        // Update references in documents
                        const res = await this.updateFileReferencesForS3(file.name, result[1], fileExtension, result[2]);
                        // Delete the original file after successful upload
                        if (res) {
                            await this.handleLocalFile(file);
                        }
                        else {
                            const res2 = await this.updateFileReferencesSecondary(file.name, result[1], fileExtension, result[2]);
                            if (res2) {
                                await this.handleLocalFile(file);
                            }
                        }
                        return;
                    }
                    else if (result && result[0] === UploadStatus.StorageLimit) {
                        await this.updateSkipedFileCount()
                        return;
                    }
                    else if (result && result[0] === UploadStatus.PerFileMaxLimit) {
                        await this.updateSkipedFileCount()
                        return;
                    }

                } catch (error) {
                    if (attempt === maxRetries) {
                        console.error(`Failed to upload ${file.name} to S3 after ${maxRetries} attempts: ${error.message}`);
                        new Notice(`Failed to upload ${file.name} to S3 after ${maxRetries} attempts: ${error.message}`);
                        await this.updateUploadedErrorFileInfo();
                    } else {
                        console.warn(`Attempt ${attempt} to upload ${file.name} failed. Retrying in ${retryDelay * attempt / 1000}s...`, 10);
                        new Notice(`${file.name} retring...`);
                        await new Promise(res => setTimeout(res, retryDelay * attempt));
                    }
                }
            }
        }
    }
}

async function initS3Client(plugin: MyPlugin) {
    if (plugin.isCloudStorage && plugin.settings.userInfo.token) {
        try {
            const response = await requestUrl({
                url: USER_MANAGER_BASE_URL + '/getStorageInfo',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${plugin.settings.userInfo.token}`
                },
                body: JSON.stringify({ "email": plugin.settings.userInfo.email })
            });

            if (response.status === 200 && response.json.error_code === 0) {
                const data = response.json;

                plugin.bucket = data.user_bucket;
                plugin.bucket_id = data.user_bucket_id;
                const prefix = data.secure ? "https://" : "http://";
                plugin.s3Client_aws = new S3Client({
                    region: "us-west-2",
                    endpoint: prefix + data.endpoint,
                    credentials: {
                        accessKeyId: data.access_key,
                        secretAccessKey: data.secret_key
                    },
                    forcePathStyle: true
                });
            } else {
                handleResponse(response.json);
            }
        } catch (error) {
            console.error('Error initializing S3 client:', error);
        }
    }
    else if (!plugin.isCloudStorage) {
                plugin.s3Client_aws = new S3Client({
            endpoint: plugin.settings.customS3Endpoint,
            region: plugin.settings.customS3Region,
            credentials: {
                accessKeyId: plugin.settings.customS3AccessKey,
                secretAccessKey: plugin.settings.customS3SecretKey
            },
            //forcePathStyle: true, // Needed for S3
        });
        plugin.bucket = plugin.settings.customS3Bucket;
    }
}

class SampleModal extends Modal {
    constructor(app: App) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.setText('Woah!');
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

export class DefaultSettingTab extends PluginSettingTab {
    plugin: MyPlugin;
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

    constructor(app: App, plugin: MyPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    async display(): Promise<void> {
        const { containerEl } = this;
        containerEl.empty();

        this.displayUserAccountSection(containerEl);
        this.displayGeneralSettingsSection(containerEl);
        this.displaySubscriptionFeaturesSection(containerEl);
        this.displayUpcomingFeaturesSection(containerEl);
        this.displayContactInfo(containerEl);
        this.fetchUserInfo().then(() => {
            this.updateUserAccountSection(containerEl);
        });
    }

    private async fetchUserInfo(): Promise<void> {
        if (this.plugin.settings.userInfo.token) {
            try {
                const response = await apiRequest(this.plugin, 'POST', '/user_info', {});
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
                new Notice('Failed to fetch user information. Please try again later.');
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

    private async getTempToken() {
        try {
            const response = await requestUrl({
                url: USER_MANAGER_BASE_URL + '/get_temp_token',
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.plugin.settings.userInfo.token}`
                }
            });

            if (response.status === 200 && response.json.error_code === 0) {
                const data = response.json;
                return data.pay_token;
            }
        } catch (error) {
            console.error('getPayToken', error);
            new Notice('Unable to jump to subscription page');
            return null;

        }
    }

    async openPaymentPage(pay_token: string) {
        const token = this.plugin.settings.userInfo.token;
        const paymentUrl = `https://pay.obcs.top?token=${pay_token}`;
        //const paymentUrl = `http://127.0.0.1:5500/payCheckout/index.html?token=${pay_token}`;
        window.open(paymentUrl, '_blank');
    }

    private displayUserAccountSection(containerEl: HTMLElement) {
        const accountSection = containerEl.createEl('div', { cls: 'setting-section' });
        accountSection.createEl('h3', { text: 'User Account' });

        if (this.plugin.settings.userInfo.token) {
            // User is logged in
            // Email setting always displayed
            const emailSetting = new Setting(accountSection)
                .setName('Email')
                .setDesc(this.plugin.settings.userInfo.email)
            emailSetting.descEl.style.color = 'red';
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

    }

    private displayGeneralSettingsSection(containerEl: HTMLElement) {
        const generalSection = containerEl.createEl('div', { cls: 'setting-section' });
        generalSection.createEl('h3', { text: 'General Settings' });

        new Setting(generalSection)
        .setName('Monitored Folders')
        .setDesc('Specify folders to monitor for attachments. All attachments in these folders will be uploaded.');

        this.plugin.settings.monitoredFolders.forEach((folder, index) => {
            this.createFolderSetting(generalSection, folder, index);
        });

        const addFolderButton = generalSection.createEl('button', { text: 'Add Folder' });
        addFolderButton.addEventListener('click', () => {
            this.plugin.settings.monitoredFolders.push('');
            this.refreshGeneralSettings(generalSection);
        });

        new Setting(containerEl)
        .setName('Local File Handling After Upload')
        .setDesc('Choose how to handle local attachments after they are successfully uploaded to the cloud.')
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
            new Setting(containerEl)
                .setName('Custom Move Folder')
                .setDesc('Specify the folder where uploaded attachments will be moved.')
                .addText(text => {text
                .setPlaceholder('Uploaded_Attachments')
                .setValue(this.plugin.settings.customMoveFolder)
                .onChange(async (value) => {
                    this.plugin.settings.customMoveFolder = value;
                    await this.plugin.saveSettings();
                });
                text.inputEl.addEventListener('focus', () => {
                    new FolderSuggest(this.app, text.inputEl);
                });
            });
        }

        
    }

    private displaySubscriptionFeaturesSection(containerEl: HTMLElement) {
        const subscriptionSection = containerEl.createEl('div', { cls: 'setting-section subscription-section' });
        const headerContainer = subscriptionSection.createEl('div', { cls: 'subscription-header' });

        headerContainer.createEl('h3', { text: 'Subscription Features', cls: 'subscription-title' });

        const upgradeButton = headerContainer.createEl('button', {
            text: 'Upgrade',
            cls: 'mod-cta subscription-upgrade-button'
        });
        upgradeButton.addEventListener('click', async () => {
            if (this.plugin.settings.userInfo.token) {
                const pay_token = await this.getTempToken();
                if (!pay_token) {
                    console.error("Pay token failed to obtain");
                    return;
                }
                this.openPaymentPage(pay_token);
            } else {
                new Notice('Please log in first.');
            }
        });

        const subscriptionNote = subscriptionSection.createEl('p', {
            text: 'Note: These features are only available to subscribed members.',
            cls: 'setting-item-description'
        });
        subscriptionNote.style.fontSize = '12px';
        subscriptionNote.style.fontStyle = 'italic';
        subscriptionNote.style.marginTop = '0';
        subscriptionNote.style.color = 'red';

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
            .setDesc('Set the maximum file size for uploads. Files larger than this will be ignored.')
            .addText(text => text
                .setPlaceholder('Enter max file size in MB')
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

    private displayUpcomingFeaturesSection(containerEl: HTMLElement) {
        const upcomingSection = containerEl.createEl('div', { cls: 'setting-section' });
        upcomingSection.createEl('h3', { text: 'Upcoming Features' });

        const featureList = upcomingSection.createEl('ul');
        const upcomingFeatures = [
            'Implement a comprehensive backup feature, allowing users to easily backup their uploaded files and facilitate future migrations.',
            'Introduce email-based authentication for accessing the file management interface, enhancing user convenience and security.',
            'Develop a feature for generating temporary share links with customizable expiration times, improving file sharing capabilities.',
            'Add functionality for uploading attachments within individual Markdown files, streamlining the content management process.',
            'Create a filename blacklist feature, giving users more control over which files are eligible for upload.'
        ];

        upcomingFeatures.forEach(feature => {
            featureList.createEl('li', { text: feature });
        });
    }

    private async resendVerificationEmail(): Promise<void> {
        try {
            const response = await apiRequest(this.plugin, 'POST', '/resend_verification', {});
            if (response) {
                new Notice('Verification email sent. Please check your inbox.');
            } else {
                throw new Error('Failed to send verification email');
            }
        } catch (error) {
            console.error('Failed to resend verification email:', error);
            new Notice('Failed to send verification email. Please try again later.');
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
        const month = String(localDate.getMonth() + 1).padStart(2, '0'); // 月份从0开始，所以要加1
        const day = String(localDate.getDate()).padStart(2, '0');

        // 返回格式化的日期字符串
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
                    if (value === 'custom') {
                        alert('Custom storage are not supported at the moment, coming soon.');
                    }
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
                    .setButtonText('Manage Storage')
                    .onClick(async () => {
                        if (this.plugin.settings.userInfo.token) {
                            const temp_token = await this.getTempToken();
                            if (!temp_token) {
                                console.error("temp token failed to obtain");
                                return;
                            }
                            window.open(`https://files.obcs.top?token=${temp_token}`, '_blank');
                            //window.open(`http://127.0.0.1:5500/objectsManager/index.html?token=${temp_token}`, '_blank');
                        } else {
                            new Notice('Please log in first.');
                        }
                    }));

            // Add Bulk File Retrieval
            new Setting(containerEl)
                .setName('Bulk File Retrieval')
                .setDesc('Retrieve multiple files at once')
                .addButton(button => button
                    .setButtonText('Retrieve Files')
                    .onClick(() => {
                        // Implement bulk file retrieval logic here
                        new Notice('Bulk file retrieval feature is not yet implemented.');
                    }));
        }

        new Setting(containerEl)
            .setName('Change Password')
            .setDesc('Change your current password.')
            .addButton(button => button
                .setButtonText('Change Password')
                .onClick(() => {
                    new ChangePasswordModal(this.app, this.plugin).open();
                }));

        // Add logout button
        new Setting(containerEl)
            .addButton(button =>
                button
                    .setButtonText('Logout')
                    .setCta()
                    .onClick(() => this.logoutUser()));
    }

    private displayEmailVerificationStatus(containerEl: HTMLElement) {
        const emailVerificationSetting = new Setting(containerEl)
            .setName('Email Verification Status');

        if (this.userInfo.isVerified) {
            emailVerificationSetting
                .setDesc('Your email has been verified');
            emailVerificationSetting.descEl.style.color = 'green';
        } else {
            emailVerificationSetting
                .setDesc('Email is not verified. Verify your email to receive an additional 512 MB of storage.')
                .addButton(button =>
                    button
                        .setButtonText('Resend Verification Email')
                        .onClick(async () => {
                            this.verifiedButton = button.buttonEl;
                            this.verifiedButton.disabled = true;
                            try {
                                await this.resendVerificationEmail();
                            } finally {
                                this.verifiedButton.disabled = false;
                            }
                                               }));
            emailVerificationSetting.descEl.style.color = 'red';
        }
    }

    private displayStorageUsage(containerEl: HTMLElement) {
        const storageUsageSetting = new Setting(containerEl)
            .setName('Storage Usage')
            .setDesc(`${this.formatSize(this.userInfo.storageUsed)} / ${this.formatSize(this.userInfo.storageLimit)} used. ⚠️ Bucket storage sizes are computed once per day.`)
            // .addExtraButton(button => button
            //     .setIcon('refresh-cw')
            //     .setTooltip('Refresh storage usage')
            //     .onClick(async () => {
            //         new Notice('Refreshing storage usage...');
            //         const res = await this.refreshStorageUsage();
            //         if (res) {
            //             storageUsageSetting.setDesc(`${this.formatSize(this.userInfo.storageUsed)} / ${this.formatSize(this.userInfo.storageLimit)} used. ⚠️ Bucket storage sizes are computed once per day.`);
            //             new Notice('Storage usage refreshed.');
            //         }
            //     })
            // )
            ;
    }

    private async refreshStorageUsage(): Promise<boolean> {
        try {
            const response = await apiRequest(this.plugin, 'POST', '/refresh_storage_usage', {});
            if (response) {
                this.userInfo.storageUsed = response.storage_used;
                this.userInfo.storageLimit = response.storage_limit;
                return true;
            } else {
                throw new Error('Failed to refresh storage usage');
            }
        } catch (error) {
            console.error('Failed to refresh storage usage:', error);
            new Notice('Failed to refresh storage usage. Please try again later.');
            return false;
        }
    }

    private displayLoggedOutUI(containerEl: HTMLElement) {
        new Setting(containerEl)
            .setName('Email')
            .addText(text => text
                .setPlaceholder('Enter your email')
                .setValue(this.plugin.settings.userInfo.email)
                .onChange(async (value) => {
                    this.plugin.settings.userInfo.email = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Password')
            .addText(text => text
                .setPlaceholder('More than 8 characters')
                .setValue('')
                .onChange(async (value) => {
                    this.tempPassword = await hashPassword(value);
                }));

        new Setting(containerEl)
            .setName('Log in')
            .addButton(button => button
                .setButtonText('Log in')
                .onClick(async () => {
                    await this.loginUser(this.plugin.settings.userInfo.email, this.tempPassword);
                }));

        new Setting(containerEl)
            .setName('Sign up')
            .addButton(button => button
                .setButtonText('Sign up')
                .onClick(async () => {
                    this.registerButton = button.buttonEl;
                    this.registerButton.disabled = true;
                    try {
                        const result = await this.plugin.registerAndWaitForRegion();
                        if (result !== null) {
                            await this.registerUser(this.plugin.settings.userInfo.email, this.tempPassword, result);
                        }
                    } catch (error) {
                        new Notice('Registration failed');
                    } finally {
                        this.registerButton.disabled = false;
                    }
                }));
        new Setting(containerEl)
            .setName('Forgot Password')
            .setDesc('Reset your password if you have forgotten it.')
            .addButton(button => button
                .setButtonText('Reset Password')
                .onClick(async () => {
                    this.resetPasswordButton = button.buttonEl;
                    this.resetPasswordButton.disabled = true;
                    try {
                        if (!this.plugin.settings.userInfo.email) {
                            new Notice('Please enter your email address first.');
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
            const response = await apiRequest(this.plugin, 'POST', '/send_reset_mail', { email });

            if (response) {
                new Notice('Password reset email has been sent. Please check your inbox.');
            }
        } catch (error) {
            console.error('Password reset failed:', error);
            new Notice('Password reset failed. Please try again later.');
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

                text.inputEl.addEventListener('focus', () => {
                    new FolderSuggest(this.app, text.inputEl);
                });
            })
            .addButton(button => button
                .setButtonText('Remove')
                .setCta()
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

    private async registerUser(email: string, password: string, region: string) {
        if (!validateEmail(email) || !validatePassword(password)) {
            new Notice('Email or password is not compliant.');
            return;
        }

        try {
            const response = await apiRequest(this.plugin, 'POST', '/register',
                { email, password, region });

            if (response) {
                this.plugin.settings.userInfo.token = response.token;
                await this.plugin.saveSettings();
                this.display();
                // initS3Client(this.plugin);
            }
        } catch (error) {
            console.error('Registration failed:', error);
            new Notice('Registration failed. Please check your network connection and try again.');
        }
    }

    private async loginUser(email: string, password: string) {
        try {
            const response = await apiRequest(this.plugin, 'POST', '/login', { email, password });

            if (response) {
                this.plugin.settings.userInfo.token = response.token;
                await this.plugin.saveSettings();
                this.display();
                // initS3Client(this.plugin);
            }
        } catch (error) {
            console.error('Login failed:', error);
            new Notice('Login failed. Please check your network connection and try again.');
        }
    }

    private async logoutUser() {
        const { token } = this.plugin.settings.userInfo;

        try {
            await apiRequest(this.plugin, 'POST', '/logout', {});
        } catch (error) {
            console.error('Logout failed:', error);
        }

        this.plugin.settings.userInfo.token = null;
        this.plugin.s3Client_aws = null;
        await this.plugin.saveSettings();
        this.display();
    }

    private displayContactInfo(containerEl: HTMLElement) {
        const contactSection = containerEl.createEl('div', { cls: 'setting-section' });
        contactSection.createEl('h3', { text: 'Contact Us' });

        const contactInfo = contactSection.createEl('p', {
            text: 'If you have any questions or need support, please contact us at: support@antmight.com',
            cls: 'setting-item-description'
        });
        contactInfo.style.fontSize = '14px';
        contactInfo.style.marginTop = '0';
    }
}

// FolderSuggest class for folder selection popup
class FolderSuggest {
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
        suggestEl.style.left = `${left}px`;
        suggestEl.style.top = `${top + inputEl.offsetHeight}px`;

        inputEl.addEventListener('blur', () => {
            setTimeout(() => suggestEl.remove(), 200);
        });
    }
}

// Add styles
const style = document.createElement('style');
style.textContent = `
.suggestion-container {
    position: absolute;
    background: white;
    border: 1px solid #ccc;
    z-index: 1000;
    max-height: 200px;
    overflow-y: auto;
}
.suggestion-container div {
    padding: 4px 8px;
    cursor: pointer;
}
.suggestion-container div:hover {
    background: #f0f0f0;
}
`;
document.head.appendChild(style);

class Lock {
    private _isLocked: boolean = false;
    private _waiting: (() => void)[] = [];

    async acquire(key: string = "count"): Promise<void> {
        while (this._isLocked) {
            await new Promise<void>(resolve => this._waiting.push(() => resolve()));
        }
        this._isLocked = true;
    }

    release(key: string = "count"): void {
        this._isLocked = false;
        if (this._waiting.length > 0) {
            const resolve = this._waiting.shift();
            if (resolve) {
                resolve();
            }
        }
    }
}

class RegionModal extends Modal {
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
            text: 'Please select the region closest to you. This will help optimize your file upload and download speeds. Once selected, this cannot be changed.',
        });
        description.style.color = 'red';
        description.style.fontSize = '0.8em';  // Set small font size

        // Add an OK button and place it in the bottom right corner
        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
        buttonContainer.style.display = 'flex';
        buttonContainer.style.justifyContent = 'flex-end';  // Right-align button

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
        dropdown.appendChild(usGroup);
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();

        // Call reject or resolve(null) to handle cancellation when Modal is closed
        this.resolve(null);  // Use null to indicate user canceled the operation
    }
}

class ChangePasswordModal extends Modal {
    plugin: MyPlugin;
    oldPassword: string = '';
    newPassword: string = '';

    constructor(app: App, plugin: MyPlugin) {
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
                .setButtonText('Change Password')
                .setCta()
                .onClick(() => this.changePassword()));
    }

    async changePassword() {
        if (!validatePassword(this.newPassword)) {
            new Notice('New password must be at least 8 characters long.');
            return;
        }

        try {
            const response = await apiRequest(this.plugin, 'POST', "/change_password",
                {
                    'old_password': await hashPassword(this.oldPassword),
                    'new_password': await hashPassword(this.newPassword),
                })

            if (response) {
                new Notice('Password changed successfully.');
                this.close();
            }
        } catch (error) {
            console.error('Password change failed:', error);
            new Notice('Password change failed. Please try again later.');
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

async function hashPassword(password: string): Promise<string> {
    if (!validatePassword(password)) {
        return '';
    }
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function handleResponse(response: any) {
    new Notice(response.error_message);
}

function validateEmail(email: string): boolean {
    // Regular expression to validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    // Check if the email format is correct
    if (!emailRegex.test(email)) {
        return false;
    }

    return true;
}

function validatePassword(password: string): boolean {
    // Check if the password length is at least 8 characters
    if (password.length < 8) {
        return false;
    }

    return true;
}

async function apiRequest(plugin: MyPlugin, method: string, endpoint: string, data: any) {
    try {
        const response = await requestUrl({
            url: USER_MANAGER_BASE_URL + endpoint,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${plugin.settings.userInfo.token}`
            },
            body: JSON.stringify(data)
        });

        if (response.status === 200 && response.json.error_code === 0) {
            console.debug('apiRequest:', response);
            return response.json;
        } else if (response.status === 200 && response.json.error_code === 6001) {
            // Invalid access token, please relogin
            new Notice('Error: Invalid access token, please relogin.');
            return null;
        } else if (response.status === 200 && response.json.error_code === 7003) {
            new Notice(response.json.error_message);
            return response.json;
        }else if (response.status === 200 && response.json.error_code === 7002) {
            new Notice(response.json.error_message);
            return response.json;
        }
        else {
            handleResponse(response.json);
            return null;
        }
    } catch (error) {
        console.error('apiRequest Error:', error);
        return null;
    }
}
       