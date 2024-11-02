export class FileTypeUtil {
    // Store mapping of file extensions to MIME types
    private static mimeTypes: { [key: string]: string } = {
        // Images
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'gif': 'image/gif',
        'webp': 'image/webp',
        'svg': 'image/svg+xml',
        
        // Documents
        'pdf': 'application/pdf',
        'doc': 'application/msword',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        
        // Audio
        'mp3': 'audio/mpeg',
        'wav': 'audio/wav',
        'm4a': 'audio/mp4',
        
        // Video
        'mp4': 'video/mp4',
        'webm': 'video/webm',
        'avi': 'video/x-msvideo',
        
        // Other common types
        'txt': 'text/plain',
        'json': 'application/json',
        'zip': 'application/zip',
        'md': 'text/markdown'
    };

    /**
     * Get the MIME type for a file
     * @param filename The name or path of the file
     * @returns MIME type string, returns 'application/octet-stream' if unknown
     */
    public static getMimeType(filename: string): string {
        // Get file extension
        const ext = filename.toLowerCase().split('.').pop();
        
        if (!ext) {
            return 'application/octet-stream';
        }
        
        // Return corresponding MIME type or default value if not found
        return this.mimeTypes[ext] || 'application/octet-stream';
    }

    /**
     * Check if the file is an image
     * @param filename The name or path of the file
     * @returns boolean
     */
    public static isImage(filename: string): boolean {
        const mimeType = this.getMimeType(filename);
        return mimeType.startsWith('image/');
    }

    /**
     * Check if the file is a video
     * @param filename The name or path of the file
     * @returns boolean
     */
    public static isVideo(filename: string): boolean {
        const mimeType = this.getMimeType(filename);
        return mimeType.startsWith('video/');
    }

    /**
     * Check if the file is an audio file
     * @param filename The name or path of the file
     * @returns boolean
     */
    public static isAudio(filename: string): boolean {
        const mimeType = this.getMimeType(filename);
        return mimeType.startsWith('audio/');
    }

    /**
     * Add a custom MIME type mapping
     * @param extension File extension (without dot)
     * @param mimeType MIME type
     */
    public static addCustomMimeType(extension: string, mimeType: string): void {
        this.mimeTypes[extension.toLowerCase()] = mimeType;
    }
}