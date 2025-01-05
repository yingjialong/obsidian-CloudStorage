export class ServiceRejectedError extends Error {
    constructor(message: string, public code?: string) {
        super(message);
        this.name = 'ServiceRejectedError';
    }
}

export interface UserInfo {
    email: string;
    access_token: string | null;
    refresh_token: string | null;
}

export interface CustomS3Config {
    endpoint: string;
    region: string;
    accessKey: string;
    secretKey: string;
    bucket: string;
    baseUrl: string;
}

export interface CloudStorageSettings {
    monitoredFolders: string[];
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
    autoUpload: boolean;
    autoMaxFileSize: number;
    noticeFlag: boolean;
    monitorSubfolders: boolean;
    selectedRegion: string | null;
    uuid: string;
    accountStatus: string | null; // new account or existing account
}


export const enum StorageKind {
    plugin = 'plugin',
    custom = 'custom'
}


export const enum UploadStatus {
    Success, // upload successfully
    StorageLimit, // upload skipped due to storage limit
    PerFileMaxLimit, // upload skipped due to per file limit
    CustomS3UploadError // error occurred when uploading to S3
}

export const enum ButtonText {
    Login = "Log in",
    VerifyConfiguration = "Verify Configuration",
    AddFolder = "Add Folder",
    ManageStorage = "Manage Storage",
    RetrieveFiles = "Retrieve Files",
    ChangePassword = "Change Password",
    Logout = "Logout",
    ResendVerificationEmail = "Send Verification Email",
    SignUp = "Sign Up",
    ResetPassword = "Reset Password",
    Upgrade = "Get Premium Now – Free!",
    Init = "Click Me",
    ChangeEmail = "Change Email",
    Proxy = "Proxy",
  }