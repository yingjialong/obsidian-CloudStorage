import { RequestUrlResponse, TAbstractFile, TFile, TFolder, moment, normalizePath, requestUrl } from "obsidian";
import { apiRequestByAccessToken } from "../api/apiRequests";
import { PART_MAX_RETRIES, USER_MANAGER_BASE_URL } from "../constants";
import CloudStoragePlugin from "../main";
import { CloudStorageSettings, StorageKind, UploadStatus } from "../types";
import { CustomS3 } from "../uploadManager/customS3";
import { getCustomS3Client } from "../uploadManager/obcsS3Client";
import { calculateMD5, generateNewFileName, getHeaderCaseInsensitive, popNotice } from "../utils/common";
import { updateFileReferencesForS3, updateFileReferencesSecondary } from "./updateFileReferences";
import { UploadStatusTracker } from "./uploadStatusTracker";

export class FilesUploadManager {
    private plugin: CloudStoragePlugin;
    private settings: CloudStorageSettings;
    private uploadStatusTracker: UploadStatusTracker;
    private customS3Client: CustomS3;
    private uploadFilePromises: Promise<void>[] = [];
    private uploadingFlag: boolean = false

    constructor(plugin: CloudStoragePlugin, uploadStatusTracker: UploadStatusTracker) {
        this.plugin = plugin;
        this.settings = { ...plugin.settings };
        this.uploadStatusTracker = uploadStatusTracker;
        if (this.settings.storageType === StorageKind.custom) {
            this.customS3Client = getCustomS3Client({
                s3Endpoint: this.settings.customS3Endpoint,
                s3Region: this.settings.customS3Region,
                s3AccessKeyID: this.settings.customS3AccessKey,
                s3SecretAccessKey: this.settings.customS3SecretKey,
                s3BucketName: this.settings.customS3Bucket
            });

        }
        else {
            // new fileUploader
        }
    }

    async uploadFiles(files: TFile[], currentPage: TFile | null = null) {
        if (this.uploadingFlag) {
            popNotice(true, 'Please wait for the previous upload to finish.');
            return;
        }
        if (files.length === 0) {
            return;
        }
        this.uploadingFlag = true;

        this.uploadStatusTracker.setUploadingFileCount(files.length);
        this.uploadStatusTracker.setUploadingFileSize(files.reduce((totalSize, file) => totalSize + file.stat.size, 0));
        try {
            this.uploadFilePromises = files.map((file, index) => 
                new Promise<void>(resolve => 
                    setTimeout(() => resolve(this.processFile(file, currentPage)), index * 50)
                )
            );
            const results = await Promise.allSettled(this.uploadFilePromises);

            // const failures = results.filter(result => result.status === 'rejected');
            // if (failures.length > 0) {

            //     const successCount = results.length - failures.length;
            //     popNotice(true, `${successCount}/${results.length} files uploaded successfully. ${failures.length} files failed.`);
            //     failures.forEach((failure, index) => {
            //         console.error(`File upload failed:`, (failure as PromiseRejectedResult).reason);
            //     });
            // } else {
            //     popNotice(false, 'All files uploaded successfully.');
            // }
        } catch (error) {
            popNotice(true, `Upload process error: ${error.message}`);
        } finally {
            this.uploadingFlag = false;
            this.uploadStatusTracker.initStatusBarItemEl();
        }
    }

    async processFile(file: TFile, currentPage: TFile | null = null) {
        let newFileName: string;
        if (this.plugin.userType === "register" || this.settings.renameFilesInCloud === false) {
            newFileName = file.name;
        }
        else {
            newFileName = generateNewFileName(file.name);
        }
        const maxRetries = 3;  // Maximum number of retries
        const retryDelay = 5000;  // Initial retry delay (milliseconds)

        const fileExtension = file.extension.toLowerCase();

        // await this.uploadStatusTracker.updateUploadingFileCount();
        // await this.uploadStatusTracker.updateUploadingFileSize(file.stat.size);

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                let result
                if (this.settings.storageType === StorageKind.custom) {
                    result = await this.uploadFileForCustomS3(file, newFileName);
                }
                else {
                    result = await this.uploadFileWithResume(file, newFileName);

                }
                if (result && result[0] === UploadStatus.Success) {
                    await this.uploadStatusTracker.updateUploadedSuccessFileInfo();
                    // Update references in documents
                    const res = await updateFileReferencesForS3(this.plugin, this.settings, file.name, result[1], fileExtension, result[2], result[3], result[4], currentPage);
                    // Delete the original file after successful upload
                    if (res) {
                        await this.handleLocalFile(file);
                    }
                    else {
                        const res2 = await updateFileReferencesSecondary(this.plugin, this.settings, file.name, result[1], fileExtension, result[2], result[3], result[4]);
                        if (res2) {
                            await this.handleLocalFile(file);
                        }
                        else {
                            popNotice(true, `Failed to update file references for ${file.name} in documents.`)
                        }
                    }
                    return;
                }
                else if (result && result[0] === UploadStatus.StorageLimit) {
                    await this.uploadStatusTracker.updateSkippedFileCount()
                    return;
                }
                else if (result && result[0] === UploadStatus.PerFileMaxLimit) {
                    await this.uploadStatusTracker.updateSkippedFileCount()
                    return;
                }
                else if (result && result[0] === UploadStatus.CustomS3UploadError) {
                    // await this.uploadStatusTracker.updateUploadedErrorFileInfo();
                    throw new Error('custom s3 upload error');
                }

            } catch (error) {
                if (attempt === maxRetries) {
                    console.error(`Failed to upload ${file.name} to S3 after ${maxRetries} attempts: ${error.message}`);
                    popNotice(this.settings.noticeFlag, `Failed to upload ${file.name} to S3 after ${maxRetries} attempts: ${error.message}`)
                    await this.uploadStatusTracker.updateUploadedErrorFileInfo();
                    throw error;
                } else {
                    console.warn(`Attempt ${attempt} to upload ${file.name} failed. Retrying in ${retryDelay * attempt / 1000}s...`, 10);
                    popNotice(this.settings.noticeFlag, `${file.name} retring...`)
                    await new Promise(res => setTimeout(res, retryDelay * attempt));
                }
            }
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
            await this.plugin.app.vault.trash(file, true);
        } else {
            // Move file to custom folder
            const targetFolderPath = this.settings.customMoveFolder || 'Uploaded_Attachments';
            let targetFolder = this.plugin.app.vault.getAbstractFileByPath(targetFolderPath);

            // Ensure the target folder exists
            if (!targetFolder) {
                targetFolder = await this.plugin.app.vault.createFolder(targetFolderPath);
            }

            if (targetFolder instanceof TFolder) {
                let newFileName = file.name;
                let newPath = normalizePath(`${targetFolder.path}/${file.name}`);
                if (await this.plugin.app.vault.adapter.exists(newPath)) {
                    newFileName = this.getUniqueFilename(file.name);
                    newPath = normalizePath(`${targetFolder.path}/${newFileName}`);
                }
                await this.plugin.app.fileManager.renameFile(file, newPath);
            } else {
                console.error(`Target is not a folder: ${targetFolderPath}`);
            }
        }
    }

    async requestUploadStart(file_hash: string, file_name: string, total_bytes: number) {
        const response = await apiRequestByAccessToken(this.plugin, 'POST',
            USER_MANAGER_BASE_URL + '/init_upload',
            { file_hash, file_name, total_bytes }
        );
        return response;
    }

    async requestCompletedUpload(upload_id: string) {
        const response = await apiRequestByAccessToken(this.plugin, 'POST',
            USER_MANAGER_BASE_URL + '/complete_upload',
            {
                upload_id: upload_id
            }
        );
        return response;
    }

    async requestNextUpload(upload_id: string, part_number: number, etag: string | null, uploaded_bytes: number) {
        const response = await apiRequestByAccessToken(this.plugin, 'POST',
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

        const fileMD5 = await this.calculateFileFingerprint(file);
        response = await this.requestUploadStart(fileMD5, key, file.stat.size)
        if (response === null) {
            console.error('Failed to request upload start: ', file.name);
            throw new Error(`Failed to upload part ${file.name}`);
        }

        if (response.upload_status == 'completed') {
            await this.uploadStatusTracker.updateUploadedFileSize(file.stat.size);
            console.info(`File ${key} already uploaded response: ${response}`);

            const folder_id = response.folder_id;
            const file_key = response.file_key;
            const public_code = response.public_code;
            const private_code = response.private_code;

            return [UploadStatus.Success, file_key, folder_id, public_code, private_code];
        }

        if (response.upload_status == 'storagelimit') {
            await this.uploadStatusTracker.updateUploadedFileSize(file.stat.size);
            return [UploadStatus.StorageLimit, "", "", "", ""];
        }
        if (response.upload_status == 'perfilemaxlimit') {
            await this.uploadStatusTracker.updateUploadedFileSize(file.stat.size);
            return [UploadStatus.PerFileMaxLimit, "", "", "", ""];
        }

        let uploadId = response.upload_id;
        let partNumber = response.part_number;
        let url = response.url;
        let CHUNK_SIZE = response.part_size;
        let uploadedBytes = response.uploaded_bytes;

        const fileContent = await this.plugin.app.vault.adapter.readBinary(file.path);
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

                await this.uploadStatusTracker.updateUploadedFileSize(chunkSize); // upload seccessed, update the uploaded file size

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

    async uploadFileForCustomS3(file: TFile, key: string): Promise<[number, string, string, string, string] | null> {
        const fullKey = this.plugin.folderName + "/" + key;
        const fileContent = await this.plugin.app.vault.adapter.readBinary(file.path);
        let retries = 0;
        try {
            while (retries < PART_MAX_RETRIES) {
                try {
                    const res = await this.customS3Client!.uploadFile(file, fullKey, this.plugin.app);
                    if (res) {
                        await this.uploadStatusTracker.updateUploadedFileSize(file.stat.size);
                        return [UploadStatus.Success, fullKey, "", "", ""];
                    }
                }
                catch (error) {
                    retries++;
                    if (retries >= PART_MAX_RETRIES) {
                        console.error(`Failed to upload ${file.name} after ${PART_MAX_RETRIES} retries. ${error}`);
                        throw error;
                    }
                    else {
                        console.warn(`Error custom S3 ${file.name}. Retrying... (${retries + 1}/${PART_MAX_RETRIES})`);
                    }
                    await new Promise(resolve => setTimeout(resolve, 1000 * retries)); // Exponential backoff
                }

            }
        }
        catch (error) {
            console.error("Error during file upload:", error);
            // Keep the progress saved so we can resume later
            throw error;
        }

        return [UploadStatus.CustomS3UploadError, "", "", "", ""];


    }

    async calculateFileFingerprint(file: TFile): Promise<string> {
        return await calculateMD5(file, this.plugin.app);
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

}
