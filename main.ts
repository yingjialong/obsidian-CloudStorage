import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, requestUrl, TFile, TFolder, setIcon, ButtonComponent, RequestUrlResponse, TAbstractFile, normalizePath, moment, getBlobArrayBuffer, FuzzySuggestModal } from 'obsidian';
import CryptoJS from 'crypto-js';
import { getClient } from "customS3Client";
import type { S3Config } from "./utils/baseTypes";
import { CustomS3 } from "./utils/customS3";
import {getHeaderCaseInsensitive} from "./utils/utils";

const VERSION = "1.2.21"
// Configuration
const PART_MAX_RETRIES = 3;
const DEFAULT_MAX_UPLOAD_SIZE = 5 * 1024 * 1024;
const LINK_BASE_URL = "https://link.obcs.top";
const USER_MANAGER_BASE_URL = 'https://obcs-api.obcs.top/api';
// const LINK_BASE_URL = "http://127.0.0.1:5002";
// const USER_MANAGER_BASE_URL = 'http://127.0.0.1:5001/api';

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
    access_token: string | null;
    refresh_token: string | null;
}

interface CloudStorageSettings {
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
    safetyLink: boolean;

}

const DEFAULT_SETTINGS: CloudStorageSettings = {
    monitoredFolders: [],
    uploadProgress: {},
    userInfo: {
        email: '',
        access_token: null,
        refresh_token: null
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
    customMoveFolder: 'Uploaded_Attachments',
    safetyLink: false
};

const enum UploadStatus {
    Success, // upload successfully
    StorageLimit, // upload skipped due to storage limit
    PerFileMaxLimit, // upload skipped due to per file limit
    CustomS3UploadError // error occurred when uploading to S3
}

export default class CloudStoragePlugin extends Plugin {
    settings: CloudStorageSettings;
    customS3Client: CustomS3 | null = null;
    bucket_id: string;
    bucket: string;
    folderName: string;
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
    private originalWindowOpen: typeof window.open;
    private editorPlugin: any = null;

    initCustomS3Client() {
        if(this.settings.storageType === "custom"){
            const config: S3Config = {
                s3Endpoint: this.settings.customS3Endpoint,
                s3Region: this.settings.customS3Region,
                s3AccessKeyID: this.settings.customS3AccessKey,
                s3SecretAccessKey: this.settings.customS3SecretKey,
                s3BucketName: this.settings.customS3Bucket
            };
            this.customS3Client = getClient(config);
        }
    }


    async onload() {
        console.info('Assets Upload plugin loaded');

        await this.loadSettings();
        this.settings.safetyLink = false;

        this.countLocker = new Lock();
        this.updateLinkLocker = new Lock();

        this.initCustomS3Client();

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
                if (file instanceof TFile) {
                    menu.addItem((item) => {
                        item
                            .setTitle('Upload attachments')
                            .setIcon('upload-cloud')
                            .onClick(() => this.uploadCurrentFileAttachments(file));
                    });
                }
            })
        );

        // Add setting tab
        this.addSettingTab(new CloudStorageSettingTab(this.app, this));

        // Create status bar item
        this.statusBarItemEl = this.addStatusBarItem();
        this.updateStatusBar();

    }


    onunload() {
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
        const response = await apiRequestByAccessToken(this, 'POST',
            USER_MANAGER_BASE_URL + '/init_upload',
            { file_hash, file_name, total_bytes }
        );
        return response;
    }

    async requestCompletedUpload(upload_id: string) {
        const response = await apiRequestByAccessToken(this, 'POST',
            USER_MANAGER_BASE_URL + '/complete_upload',
            {
                upload_id: upload_id
            }
        );
        return response;
    }

    async requestNextUpload(upload_id: string, part_number: number, etag: string | null, uploaded_bytes: number) {
        const response = await apiRequestByAccessToken(this, 'POST',
            USER_MANAGER_BASE_URL + '/upload_part',
            {
                upload_id: upload_id,
                part_number: part_number,
                etag: etag,
                uploaded_bytes: uploaded_bytes
            }
        );
        return response;
    }

    async uploadFileWithResume(file: TFile, key: string): Promise<[number, string, string, string, string] | null> {
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

            const folder_id = response.folder_id;
            const file_key = response.file_key;
            const public_code = response.public_code;
            const private_code = response.private_code;

            return [UploadStatus.Success, file_key, folder_id, public_code, private_code];
        }

        if (response.upload_status == 'storagelimit') {
            await this.updateUploadedFileSize(file.stat.size);
            return [UploadStatus.StorageLimit, "", "", "", ""];
        }
        if (response.upload_status == 'perfilemaxlimit') {
            await this.updateUploadedFileSize(file.stat.size);
            return [UploadStatus.PerFileMaxLimit, "", "", "", ""];
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

                        etag = getHeaderCaseInsensitive(uploadResponse.headers, 'etag')
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
                response = await this.requestNextUpload(uploadId, partNumber, etag!, end);
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
            const folder_id = response.folder_id;
            const file_key = response.file_key;
            const public_code = response.public_code;
            const private_code = response.private_code;

            return [UploadStatus.Success, file_key, folder_id, public_code, private_code];

        } catch (error) {
            console.error("Error during file upload:", error);
            // Keep the progress saved so we can resume later
            throw error;
        }
    }

    async uploadFileForCustomeS3(file: TFile, key: string): Promise<[number, string, string, string, string] | null> {
        if(!this.customS3Client)
        {
            this.initCustomS3Client(); 
        }
        const fullKey = this.folderName+"/"+key;
        const fileContent = await this.app.vault.adapter.readBinary(file.path);
        let retries = 0;
        try {
            while (retries < PART_MAX_RETRIES) {
                const res = await this.customS3Client!.uploadFile(file, fullKey, this.app);
                if (res) {
                    return [UploadStatus.Success, fullKey, "", "", ""];
                }  
            }
        }
        catch (error) {
            retries++;
            if (retries >= PART_MAX_RETRIES) {
                console.error(`Failed to upload ${file.name} after ${PART_MAX_RETRIES} retries. ${error}`);
                throw error;
            }
            else {
                console.warn(`Error uploading part ${file.name}. Retrying... (${retries + 1}/${PART_MAX_RETRIES})`);
            }
            await new Promise(resolve => setTimeout(resolve, 1000 * retries)); // Exponential backoff
        }

        return [UploadStatus.CustomS3UploadError, "", "", "", ""];

        
    }

    async calculateMD5(file: TFile): Promise<string> {

        // Read the entire file as Blob
        const fileBlob = new Blob([await this.app.vault.readBinary(file)]);

        const md5 = CryptoJS.algo.MD5.create();
        const chunkSize = 64 * 1024 * 1024; // 64MB, adjust as needed
        const fileSize = fileBlob.size;
        let notice: Notice | null = null;
        if (fileSize > chunkSize * 3) {
            notice = new Notice(`Calculating MD5 for ${file.name}`, 0);
        }

        for (let offset = 0; offset < fileSize; offset += chunkSize) {
            // Use Blob.slice() to get the current chunk of the file
            const chunk = fileBlob.slice(offset, Math.min(offset + chunkSize, fileSize));

            // Convert Blob chunk to ArrayBuffer
            const chunkBuffer = await getBlobArrayBuffer(chunk);

            // Convert ArrayBuffer to CryptoJS supported WordArray
            const wordArray = CryptoJS.lib.WordArray.create(chunkBuffer as ArrayBuffer);

            // Update MD5 calculation
            md5.update(wordArray);
            if (notice) {
                notice.setMessage(`Calculating MD5 for ${file.name} - ${Math.round((offset / fileSize) * 100)}%`);
            }
        }

        // Calculate the final MD5 hash
        const md5Hash = md5.finalize().toString();
        if (notice) {
            notice.hide();
        }

        return md5Hash;
    }

    async updateSkippedFileCount() {
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
                this.proccessNotice = new Notice(`Uploading ${this.uploadedFileCount} of ${this.uploadingFileCount} files... [${percent}% done][${this.skipUploadCount} files skipped]`, 0);
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
    async updateFileReferencesForS3(originalName: string, fileKey: string, fileExtension: string, bucketid: string, public_code: string, private_code: string, currentPage: TFile | null = null) {
        let allMarkdownFiles: TFile[] = [];
        if (currentPage) {
            allMarkdownFiles.push(currentPage);
            console.debug(`Updating references for all markdown files in ${currentPage.path}` );
        }
        else {
            allMarkdownFiles = this.app.vault.getMarkdownFiles();
        }
        let findFlag = false;
        let updated = false;
        const safetyType = this.settings.safetyLink ? "private" : "public";
        const safetyCode = this.settings.safetyLink ? private_code : public_code;
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
                    let url = ""
                    if (this.settings.storageType === "custom")
                        url = encodeURI(`${this.settings.customS3BaseUrl}/${fileKey}`)
                    else
                        url = encodeURI(`${LINK_BASE_URL}/${safetyType}/${bucketid}/${safetyCode}/${fileKey}`)
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

    async updateFileReferencesSecondary(originalName: string, fileKey: string, fileExtension: string, bucketid: string, public_code: string, private_code: string, currentPage: TFile | null = null) {
        let allMarkdownFiles: TFile[] = [];
        if (currentPage) {
            allMarkdownFiles.push(currentPage);
            console.debug(`Updating references for all markdown files2 in ${currentPage.path}` );
        }
        else {
            allMarkdownFiles = this.app.vault.getMarkdownFiles();
        }
        let updated = false;
        const safetyType = this.settings.safetyLink ? "private" : "public";
        const safetyCode = this.settings.safetyLink ? private_code : public_code;
        for (const file of allMarkdownFiles) {
            if (file) {
                let imageFlag = '';
                if (['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif', 'bmp', 'tiff'].includes(fileExtension)) {
                    imageFlag = '!';
                }
                await this.updateLinkLocker.acquire(originalName);
                try {
                    let url = ""
                    if (this.settings.storageType === "custom")
                        url = encodeURI(`${this.settings.customS3BaseUrl}/${fileKey}`)
                    else
                        url = encodeURI(`${LINK_BASE_URL}/${safetyType}/${bucketid}/${safetyCode}/${fileKey}`)
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

    async uploadCurrentFileAttachments(currentPage: TFile) {
        if (this.proccessing) {
            new Notice("Please wait for the previous upload to finish.");
            return;
        }

        // Preliminary Preparation for Uploading Files
        if (!await this.preliminaryforUploading())
        {
            new Notice("Network Error. Please check your internet connection.");
            return;
        }

        try {
            // Retrieve the cache of the current file to find all embedded attachments.
            const fileCache = this.app.metadataCache.getFileCache(currentPage);
            const uploadPromises: Promise<void>[] = [];
            
            if (fileCache && fileCache.embeds) {
                for (const embed of fileCache.embeds) {
                    // Retrieve the file corresponding to the link.
                    const linkedFile = this.app.metadataCache.getFirstLinkpathDest(embed.link, currentPage.path);
                    
                    if (linkedFile instanceof TFile && linkedFile.extension !== 'md') {
                        // Check if the file should be processed.
                        if (this.shouldProcessFile(linkedFile)) {
                            const uploadPromise = this.processFile(linkedFile, currentPage);
                            uploadPromises.push(uploadPromise);
                            await new Promise(resolve => setTimeout(resolve, 500));
                        } else {
                            await this.updateSkippedFileCount();
                            new Notice(`Skipping file ${linkedFile.path}`);
                        }
                    }
                }
            }

            // Wait for all uploads to complete
            await Promise.all(uploadPromises);
            new Notice(`Storage completed: success ${this.uploadedSuccessFileCount}, failure ${this.uploadedErrorFileCount}, skipped ${this.skipUploadCount}`);
        } catch (error) {
            console.error("Error uploading attachments:", error);
            new Notice("Error uploading attachments");
        } finally {
            this.statusBarItemEl.empty();
            const iconEl = this.statusBarItemEl.createEl("span", { cls: "status-bar-item-icon" });
            setIcon(iconEl, 'file-up');
            this.proccessing = false;
        }
    }

    async uploadAllAttachments() {
        // if (this.settings.storageType === "custom") {
        //     new Notice("Custom storage are not supported at the moment, coming soon.");
        //     return;
        // }

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

        // Preliminary Preparation for Uploading Files
        if (!await this.preliminaryforUploading())
        {
            new Notice("Network Error. Please check your internet connection.");
            return;
        }

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
        new Notice(`Storage completed: success ${this.uploadedSuccessFileCount}, failure ${this.uploadedErrorFileCount}, skipped ${this.skipUploadCount}`);
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
                    await this.updateSkippedFileCount()
                    new Notice(`Skipping file ${file.path}`);
                }
            }
        }
    }

    private async preliminaryforUploading(): Promise<boolean> {
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

        this.proccessing = true;
        this.proccessNotice = null;

        // Initialize upload counters
        this.uploadingFileCount = 0; // Total number of files to be uploaded
        this.uploadedFileCount = 0; // Number of files already uploaded
        this.uploadedS3FileSize = 0; // Total size of files already uploaded
        this.uploadingFileSize = 0; // Total size of files to be uploaded
        this.uploadedErrorFileCount = 0;
        this.uploadedSuccessFileCount = 0;
        this.skipUploadCount = 0;
        
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

    async processFile(file: TFile, currentPage: TFile | null = null) {
        if (!this.settings.userInfo.refresh_token) {
            new Notice('Please relogin');
            return;
        }


        const newFileName = this.generateNewFileName(file.name);
        const maxRetries = 3;  // Maximum number of retries
        const retryDelay = 5000;  // Initial retry delay (milliseconds)

        const fileExtension = file.extension.toLowerCase();

        await this.updateUploadingFileCount();
        await this.updateUploadingFileSize(file.stat.size);

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                let result
                if (this.settings.storageType === "custom")
                {
                    result = await this.uploadFileForCustomeS3(file, newFileName);
                }
                else{
                    result = await this.uploadFileWithResume(file, newFileName);

                }
                if (result && result[0] === UploadStatus.Success) {
                    await this.updateUploadedSuccessFileInfo();
                    await this.updateUploadedFileCount();
                    // Update references in documents
                    const res = await this.updateFileReferencesForS3(file.name, result[1], fileExtension, result[2], result[3], result[4], currentPage);
                    // Delete the original file after successful upload
                    if (res) {
                        await this.handleLocalFile(file);
                    }
                    else {
                        const res2 = await this.updateFileReferencesSecondary(file.name, result[1], fileExtension, result[2], result[3], result[4]);
                        if (res2) {
                            await this.handleLocalFile(file);
                        }
                    }
                    return;
                }
                else if (result && result[0] === UploadStatus.StorageLimit) {
                    await this.updateSkippedFileCount()
                    return;
                }
                else if (result && result[0] === UploadStatus.PerFileMaxLimit) {
                    await this.updateSkippedFileCount()
                    return;
                }
                else if (result && result[0] === UploadStatus.CustomS3UploadError) {
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
        this.displayUserAccountSection(containerEl);
        this.displayGeneralSettingsSection(containerEl);
        this.displaySubscriptionFeaturesSection(containerEl);
        this.displayContactInfo(containerEl);
        this.fetchUserInfo().then(() => {
            this.updateUserAccountSection(containerEl);
        });
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



    async openPaymentPage(pay_token: string) {
        const paymentUrl = `https://pay.obcs.top?token=${pay_token}`;
        // const paymentUrl = `http://127.0.0.1:5500/payCheckout/index.html?token=${pay_token}`;
        window.open(paymentUrl, '_blank');
    }

    private displayUserAccountSection(containerEl: HTMLElement) {
        const accountSection = containerEl.createEl('div', { cls: 'setting-section' });
        new Setting(accountSection).setName('User Account').setHeading();

        if (this.plugin.settings.userInfo.refresh_token) {
            // User is logged in
            // Email setting always displayed
            const emailSetting = new Setting(accountSection)
                .setName('Email')
                .setDesc(this.plugin.settings.userInfo.email)
            emailSetting.descEl.addClass('email-desc');
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
            .setButtonText('Verify Configuration')
            .setCta()
            .onClick(async () => {
                const loadingNotice = new Notice('Verifying S3 configuration...', 0);
                try {
                    const result = await this.verifyS3Configuration();
                    loadingNotice.hide();
                    if (result) {
                        new Notice('S3 configuration verified successfully!');
                    }
                } catch (error) {
                    loadingNotice.hide();
                    new Notice(`Verification failed: ${error.message}`);
                }
            }));

    }

    private displayGeneralSettingsSection(containerEl: HTMLElement) {
        const generalSection = containerEl.createEl('div', { cls: 'setting-section' });
        new Setting(generalSection).setName('Local').setHeading();

        new Setting(generalSection)
            .setName('Monitored Folders')
            .setDesc('Specify folders to monitor for attachments. All attachments in these folders will be uploaded.')
            .addButton(button => button
                .setButtonText('Add Folder')
                .setCta()
                .onClick(async () => {
                    this.plugin.settings.monitoredFolders.push('');
                    this.refreshGeneralSettings(generalSection);
                }));

        this.plugin.settings.monitoredFolders.forEach((folder, index) => {
            this.createFolderSetting(generalSection, folder, index);
        });

        new Setting(generalSection)
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

        const upgradeButton = headerContainer.createEl('button', {
            text: 'Upgrade',
            cls: 'mod-cta subscription-upgrade-button'
        });
        upgradeButton.addEventListener('click', async () => {
            if (this.plugin.settings.userInfo.refresh_token) {
                const pay_token = await getTempToken(this.plugin,"upgrade");
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
            cls: 'custom-setting-item-description'
        });

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
    

    private async verifyS3Configuration(): Promise<boolean> {
        this.plugin.initCustomS3Client()
        // const abstractFile = this.app.vault.getAbstractFileByPath('Assets/testdev_accessKeys.csv');
        // if (abstractFile instanceof TFile) {
        //     const file: TFile = abstractFile;
        //     return await this.plugin.customS3Client!.uploadFile(file, this.app)

        // }
        // return false;

        const errors = { msg: "" };
        const res = await this.plugin.customS3Client!.checkConnect((err: any) => {
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
        try {
            const response = await apiRequestByAccessToken(this.plugin, 'POST', USER_MANAGER_BASE_URL + '/resend_verification', {});
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
                    .setButtonText('Manage Storage')
                    .onClick(async () => {
                        if (this.plugin.settings.userInfo.refresh_token) {
                            const temp_token = await getTempToken(this.plugin,"manage");
                            if (!temp_token) {
                                console.error("temp token failed to obtain");
                                return;
                            }
                            window.open(`https://files.obcs.top?token=${temp_token}`, '_blank');
                            // window.open(`http://127.0.0.1:5500/objectsManager/index.html?token=${temp_token}`, '_blank');
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
            emailVerificationSetting.descEl.addClass('email-verified');
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
            emailVerificationSetting.descEl.addClass('email-not-verified');
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
            const response = await apiRequestByAccessToken(this.plugin, 'POST', USER_MANAGER_BASE_URL + '/send_reset_mail', { email });

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

    private async registerUser(email: string, password: string, region: string) {
        if (!validateEmail(email) || !validatePassword(password)) {
            new Notice('Email or password is not compliant.');
            return;
        }

        try {
            const response = await apiRequestByAccessToken(this.plugin, 'POST', USER_MANAGER_BASE_URL + '/register',
                { email, password, region });

            if (response) {
                this.plugin.settings.userInfo.access_token = response.access_token;
                this.plugin.settings.userInfo.refresh_token = response.refresh_token;
                await this.plugin.saveSettings();
                this.display();
                this.plugin.initCustomS3Client();
            }
        } catch (error) {
            console.error('Registration failed:', error);
            new Notice('Registration failed. Please check your network connection and try again.');
        }
    }

    private async loginUser(email: string, password: string) {
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
            new Notice('Login failed. Please check your network connection and try again.');
        }
    }

    private async logoutUser() {

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

        inputEl.addEventListener('blur', () => {
            setTimeout(() => suggestEl.remove(), 200);
        });
    }
}

class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
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
            text: 'Please select the region closest to you. This will help optimize your file upload and download speeds.',
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

class ChangePasswordModal extends Modal {
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
            const response = await apiRequestByAccessToken(this.plugin, 'POST', USER_MANAGER_BASE_URL + "/change_password",
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

async function apiRequestByAccessToken(plugin: CloudStoragePlugin, method: string, url: string, data: any, token: string | null = null, type: string = 'json') {
    try {
        const response = await requestUrl({
            url: url,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token ?? plugin.settings.userInfo.access_token}`
            },
            body: JSON.stringify(data)
        });
        if (response.status === 200 && type == 'stream') {
            return response
        }
        else if (response.status === 200 && response.json.detail.error_code === 0) {
            console.debug('apiRequestByAccessToken:', response);
            return response.json.detail;
        } else if (response.status === 200 && response.json.detail.error_code === 6001) {
            const response2 = await refreshAccessToken(plugin);
            if (response2) {
                const response3 = await requestUrl({
                    url: url,
                    method: method,
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token ?? plugin.settings.userInfo.access_token}`
                    },
                    body: JSON.stringify(data)
                });
                if (response3.status === 200 && type == 'stream') {
                    return response3
                }
                else if (response3.status === 200 && response3.json.detail.error_code === 0) {
                    console.debug('apiRequestByAccessToken:', response3);
                    return response3.json.detail;
                }
                else if (response3.status === 200 && response3.json.error_code === 0) {
                    return response3.json;
                } else if (response3.status === 200 && response3.json.error_code === 6001) {
                    // Invalid access token, please relogin
                    new Notice('Error: Invalid access token, please relogin.');
                    return null;
                } else if (response3.status === 200 && response3.json.error_code === 7003) {
                    new Notice(response3.json.error_message);
                    return response3.json;
                } else if (response3.status === 200 && response3.json.error_code === 7002) {
                    new Notice(response3.json.error_message);
                    return response3.json;
                }
                else {
                    handleResponse(response3.json.detail);
                    return null;
                }
            }
            else {
                new Notice('Error: Invalid access token, please relogin.');
                return null;
            }

        } else if (response.status === 200 && response.json.detail.error_code === 7003) {
            new Notice(response.json.detail.error_message);
            return response.json.detail;
        } else if (response.status === 200 && response.json.detail.error_code === 7002) {
            new Notice(response.json.detail.error_message);
            return response.json.detail;
        }
        else {
            handleResponse(response.json.detail);
            return null;
        }
    } catch (error) {
        console.error('apiRequestByAccessToken Error:', error);
        throw new Error('apiRequestByAccessToken Error: ' + error);
    }
}

async function apiRequestByRefreshToken(plugin: CloudStoragePlugin, method: string, url: string, data: any, type: string = 'json') {
    try {
        const response = await requestUrl({
            url: url,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${plugin.settings.userInfo.refresh_token}`
            },
            body: JSON.stringify(data)
        });

        if (response.status === 200 && type == 'stream') {
            return response
        }
        else if (response.status === 200 && response.json.detail.error_code === 0) {
            console.debug('apiRequestByRefreshToken:', response);
            return response.json.detail;
        } else if (response.status === 200 && response.json.detail.error_code === 6001) {
            // Invalid access token, please relogin
            new Notice('Error: Invalid access token, please relogin.');
            return null;
        } else if (response.status === 200 && response.json.detail.error_code === 7003) {
            new Notice(response.json.detail.error_message);
            return response.json.detail;
        } else if (response.status === 200 && response.json.detail.error_code === 7002) {
            new Notice(response.json.detail.error_message);
            return response.json.detail;
        }
        else {
            handleResponse(response.json.detail);
            return null;
        }
    } catch (error) {
        console.error('apiRequestByRefreshToken Error:', error);
        throw new Error('apiRequestByRefreshToken Error: ' + error);
    }
}

async function refreshAccessToken(plugin: CloudStoragePlugin) {
    try {
        const response = await apiRequestByRefreshToken(plugin, 'POST', USER_MANAGER_BASE_URL + '/refresh_access_token', {});

        if (response) {
            plugin.settings.userInfo.access_token = response.access_token;
            await plugin.saveSettings();
            console.info('Refresh access token success');
            return response.access_token;
        }
    } catch (error) {
        console.error('getAccessToken', error);
        new Notice('Get access token failed');
        return null;

    }
}

async function getTempToken(plugin: CloudStoragePlugin, goal: string) {
    try {
        const response = await requestUrl({
            url: USER_MANAGER_BASE_URL + '/get_temp_token',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${plugin.settings.userInfo.access_token}`
            },
            body: JSON.stringify({
                "goal": goal
            })
        });

        if (response.status === 200 && response.json.detail.error_code === 0) {
            const data = await response.json.detail;
            return data.tmp_token;
        }
    } catch (error) {
        console.error('tmp_token', error);
        new Notice('Unable to obtain token');
        return null;

    }
}