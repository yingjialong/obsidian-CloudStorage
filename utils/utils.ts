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