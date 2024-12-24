import { Notice, setIcon } from "obsidian";
import { Lock } from "../utils/Locker";
import { popNotice } from "../utils/common";

export class UploadStatusTracker {
    skipUploadCount: number = 0; // Number of files skipped
    uploadingFileCount: number = 0; // Total number of files to be uploaded
    uploadedErrorFileCount: number = 0; // Number of files that failed to upload
    uploadedSuccessFileCount: number = 0; // Number of files successfully uploaded
    uploadedS3FileSize: number = 0; // Total size of files already uploaded to S3
    uploadingFileSize: number = 0; // Total size of files to be uploaded
    private countLocker: Lock;
    private statusBarItemEl: HTMLElement;
    private proccessNotice: Notice | null = null;
    private noticeFlag: boolean = false;

    constructor(statusBarItemEl: HTMLElement, noticeFlag: boolean) {
        this.noticeFlag = noticeFlag;
        this.statusBarItemEl = statusBarItemEl;
        this.countLocker = new Lock();
    }

    async setUploadingFileCount(count: number) {
        await this.countLocker.acquire()
        try {
            this.uploadingFileCount += count;
            this.updateStatusBar();
        }
        finally {
            this.countLocker.release();
        }
    }

    async setUploadingFileSize(size: number) {
        await this.countLocker.acquire()
        try {
            this.uploadingFileSize += size;
            this.updateStatusBar();
        }
        finally {
            this.countLocker.release();
        }
    }


    async updateSkippedFileCount() {
        await this.countLocker.acquire()
        try {
            this.skipUploadCount++;
            this.updateStatusBar()
        }
        finally {
            this.countLocker.release();
        }
    }
    async updateUploadedErrorFileInfo() {
        await this.countLocker.acquire()
        try {
            this.uploadedErrorFileCount++;
            this.updateStatusBar();
        }
        finally {
            this.countLocker.release();
        }
    }

    async updateUploadedSuccessFileInfo() {
        await this.countLocker.acquire()
        try {
            this.uploadedSuccessFileCount++;
            this.updateStatusBar();
        }
        finally {
            this.countLocker.release();
        }
    }

    async updateUploadingFileCount() {
        await this.countLocker.acquire()
        try {
            this.uploadingFileCount++;
            this.updateStatusBar();
        }
        finally {
            this.countLocker.release();
        }
    }

    async updateUploadingFileSize(fileSize: number) {
        await this.countLocker.acquire()
        try {
            this.uploadingFileSize += fileSize;
            this.updateStatusBar();
        }
        finally {
            this.countLocker.release();
        }
    }

    async updateUploadedFileSize(uploadedS3FileSize: number) {
        await this.countLocker.acquire()
        try {
            this.uploadedS3FileSize += uploadedS3FileSize;
            this.updateStatusBar();
        }
        finally {
            this.countLocker.release();
        }
    }

    initStatusBarItemEl() {
        this.statusBarItemEl.empty();
        const iconEl = this.statusBarItemEl.createEl("span", { cls: "status-bar-item-icon" });
        setIcon(iconEl, 'upload-cloud');
        this.statusBarItemEl.createEl("span", { cls: "status-bar-item-segment", text: `\u00A0ready` });
    }

    updateStatusBar() {
        this.statusBarItemEl.empty(); // Clear existing content
        const iconEl = this.statusBarItemEl.createEl("span", { cls: "status-bar-item-icon" });
        setIcon(iconEl, 'upload-cloud');
        

        // Files that were skipped are not included in the uploaded file count calculation
        const uploadedFileCount = this.uploadedSuccessFileCount + this.uploadedErrorFileCount;
        // Calculate upload progress percentage, floor it
        const sizePercent = Math.floor(this.uploadedS3FileSize / this.uploadingFileSize * 100);
        const countPercent = Math.floor(uploadedFileCount / this.uploadingFileCount * 100);
        let percent = sizePercent; //Math.max(sizePercent, countPercent);
        if (this.uploadingFileCount === uploadedFileCount || percent > 100) 
        {
            percent = 100;
            this.proccessNotice?.hide();
            this.proccessNotice = null;
            // popNotice(this.settings.noticeFlag, `Uploading ${this.uploadedSuccessFileCount} of ${this.uploadingFileCount} files... [${percent}% done][${this.skipUploadCount} files skipped]`)
        }
        this.statusBarItemEl.createEl("span", { cls: "status-bar-item-segment", text: `\u00A0${percent}%` });
        if (this.proccessNotice) {
            this.proccessNotice.setMessage(`Uploading ${this.uploadedSuccessFileCount} of ${this.uploadingFileCount} files... [${percent}% done][${this.skipUploadCount} files skipped]`);
        } // Uploading [x] of [y] files... ([z]% done)
        else if (this.uploadingFileCount != uploadedFileCount){
            this.proccessNotice = popNotice(this.noticeFlag, `Uploading ${this.uploadedSuccessFileCount} of ${this.uploadingFileCount} files... [${percent}% done][${this.skipUploadCount} files skipped]`, 0)
        }

        // console.log(`
        //     Skip Upload Count: ${this.skipUploadCount}
        //     Uploading File Count: ${this.uploadingFileCount}
        //     Uploaded Error File Count: ${this.uploadedErrorFileCount}
        //     Uploaded Success File Count: ${this.uploadedSuccessFileCount}
        //     Uploaded S3 File Size: ${this.uploadedS3FileSize}
        //     Uploading File Size: ${this.uploadingFileSize}
        // `);

    }
}