import { CloudStorageSettings } from "./types";

export const VERSION = "1.5.32";
// Configuration
export const PART_MAX_RETRIES = 3;
export const DEFAULT_MAX_UPLOAD_SIZE = 5 * 1024 * 1024;
export const DEFAULT_MAX_UPLOAD_SIZE_AUTO = 20;
export const DEFAULT_PASSWORD = "Obcs_88py";
export const LINK_BASE_URL = "https://link.obcs.top";
export const USER_MANAGER_BASE_URL = 'https://obcs-api.obcs.top/api';
// export const LINK_BASE_URL = "http://127.0.0.1:5002";
// export const USER_MANAGER_BASE_URL = 'http://127.0.0.1:5001/api';
// export const USER_MANAGER_BASE_URL = 'https://dev.wor1d.top/api';

export const DEFAULT_SETTINGS: CloudStorageSettings = {
    monitoredFolders: [],
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
    safetyLink: false,
    autoUpload: true,
    autoMaxFileSize: DEFAULT_MAX_UPLOAD_SIZE_AUTO,
    noticeFlag: false,
    selectedRegion: null,
    uuid: '',
    accountStatus: null,
    monitorSubfolders: false
};