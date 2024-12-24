import { TFile } from "obsidian";
import { LINK_BASE_URL } from "../constants";
import CloudStoragePlugin from "../main";
import { CloudStorageSettings } from "../types";

export async function updateFileReferencesForS3(plugin: CloudStoragePlugin, settings: CloudStorageSettings, originalName: string, fileKey: string, fileExtension: string, bucketid: string, public_code: string, private_code: string, currentPage: TFile | null = null) {
    let allMarkdownFiles: TFile[] = [];
    if (currentPage) {
        allMarkdownFiles.push(currentPage);
        console.debug(`Updating references for all markdown files in ${currentPage.path}`);
    }
    else {
        allMarkdownFiles = plugin.app.vault.getMarkdownFiles();
    }
    let findFlag = false;
    let updated = false;
    const safetyType = settings.safetyLink ? "private" : "public";
    const safetyCode = settings.safetyLink ? private_code : public_code;
    for (const file of allMarkdownFiles) {
        let skipFlag = true;
        if (file) {
            const cache = plugin.app.metadataCache.getFileCache(file);
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
            await plugin.updateLinkLocker.acquire(originalName);
            try {
                let url = ""
                if (settings.storageType === "custom")
                    url = encodeURI(`${settings.customS3BaseUrl}/${fileKey}`)
                else
                    url = encodeURI(`${LINK_BASE_URL}/${safetyType}/${bucketid}/${safetyCode}/${fileKey}`)
                const content = await plugin.app.vault.read(file);
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
                    await plugin.app.vault.modify(file, newContent);
                    updated = true;
                    const testcontent = await plugin.app.vault.read(file);
                }
            } finally {
                plugin.updateLinkLocker.release(originalName);
            }
        }
    }
    if (!findFlag) console.debug(`not found ${originalName} content`);

    return updated;
}

export async function updateFileReferencesSecondary(plugin: CloudStoragePlugin, settings: CloudStorageSettings, originalName: string, fileKey: string, fileExtension: string, bucketid: string, public_code: string, private_code: string, currentPage: TFile | null = null) {
    let allMarkdownFiles: TFile[] = [];
    if (currentPage) {
        allMarkdownFiles.push(currentPage);
        console.debug(`Updating references for all markdown files2 in ${currentPage.path}`);
    }
    else {
        allMarkdownFiles = plugin.app.vault.getMarkdownFiles();
    }
    let updated = false;
    const safetyType = settings.safetyLink ? "private" : "public";
    const safetyCode = settings.safetyLink ? private_code : public_code;
    for (const file of allMarkdownFiles) {
        if (file) {
            let imageFlag = '';
            if (['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif', 'bmp', 'tiff'].includes(fileExtension)) {
                imageFlag = '!';
            }
            await plugin.updateLinkLocker.acquire(originalName);
            try {
                let url = ""
                if (settings.storageType === "custom")
                    url = encodeURI(`${settings.customS3BaseUrl}/${fileKey}`)
                else
                    url = encodeURI(`${LINK_BASE_URL}/${safetyType}/${bucketid}/${safetyCode}/${fileKey}`)
                const content = await plugin.app.vault.read(file);
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
                    await plugin.app.vault.modify(file, newContent);
                    updated = true;
                }
            } finally {
                plugin.updateLinkLocker.release(originalName);
            }
        }
    }

    return updated;
}