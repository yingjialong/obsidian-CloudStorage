import { Notice, getBlobArrayBuffer } from 'obsidian';
import { CloudStorageSettings } from '../types';
import { TFile } from 'obsidian';
import CryptoJS from 'crypto-js';

/**
 * A helper function to get header value case-insensitively from Obsidian RequestUrlResponse
 * @param headers - Response headers from RequestUrlResponse
 * @param headerName - The name of the header to retrieve
 * @returns The header value or undefined if not found
 */
export function getHeaderCaseInsensitive(
    headers: Record<string, string>,
    headerName: string
): string | undefined {
    // First try direct access
    const directValue = headers[headerName];
    if (directValue) {
        return directValue;
    }

    // Try case-insensitive search
    const headerLower = headerName.toLowerCase();
    const key = Object.keys(headers).find(
        k => k.toLowerCase() === headerLower
    );

    return key ? headers[key] : undefined;
}

export async function hashPassword(password: string): Promise<string> {
    if (!validatePassword(password)) {
        return '';
    }
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function handleResponse(response: any) {
    popNotice(true, response.error_message);
}

export function validateEmail(email: string): boolean {
    // Regular expression to validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    // Check if the email format is correct
    if (!emailRegex.test(email)) {
        return false;
    }

    return true;
}

export function validatePassword(password: string): boolean {
    // Check if the password length is at least 8 characters
    if (password.length < 8) {
        return false;
    }

    return true;
}

export function popNotice(flag: boolean, message: string, duration?: number): Notice|null {
    // Check if the password length is at least 8 characters
    if (flag)
        return new Notice(message,duration);
    else
        return null;
}

export function safeGetSettingsValue(settings: CloudStorageSettings): Partial<CloudStorageSettings> {
    const {
        customS3Endpoint,
        customS3Region, 
        customS3AccessKey,
        customS3SecretKey,
        customS3Bucket,
        customS3BaseUrl,
        ...rest
    } = settings;
    
    return rest;
}

export async function calculateMD5(file: TFile, app: any): Promise<string> {
    // Read the entire file as Blob
    const fileBlob = new Blob([await app.vault.readBinary(file)]);

    const md5 = CryptoJS.algo.MD5.create();
    const chunkSize = 64 * 1024 * 1024; // 64MB, adjust as needed
    const fileSize = fileBlob.size;
    let notice: Notice | null = null;
    if (fileSize > chunkSize * 3) {
        notice = popNotice(true,`Calculating MD5 for ${file.name}`, 0)
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

/**
 * Generate new file name
 * @param originalName Original file name
 * @returns New file name
 */
export function generateNewFileName(originalName: string): string {
    //let urlFriendlyName = encodeURIComponent(originalName);
    let urlFriendlyName = originalName.replace(/\s/gi, '_');
    const timestamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
    const randomSuffix = Math.random().toString(36).substring(2, 6);
    const extensionIndex = urlFriendlyName.lastIndexOf('.');
    const baseName = urlFriendlyName.substring(0, extensionIndex);
    const extension = urlFriendlyName.substring(extensionIndex);
    return `${baseName}_${timestamp}_${randomSuffix}${extension}`;
}