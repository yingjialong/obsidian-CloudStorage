import { Platform, requestUrl } from "obsidian";
import { USER_MANAGER_BASE_URL, VERSION } from "../constants";
import CloudStoragePlugin from "../main";
import { handleResponse, popNotice, safeGetSettingsValue } from "../utils/common";

export async function apiRequestByAccessToken(plugin: CloudStoragePlugin, method: string, url: string, data: any, token: string | null = null, type: string = 'json') {
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
                    popNotice(true, 'Error: Invalid access token, please relogin.');
                    return null;
                } else if (response3.status === 200 && response3.json.error_code === 7003) {
                    popNotice(true, response3.json.error_message);
                    return response3.json;
                } else if (response3.status === 200 && response3.json.error_code === 7002) {
                    popNotice(true, response3.json.error_message);
                    return response3.json;
                }
                else {
                    handleResponse(response3.json.detail);
                    return null;
                }
            }
            else {
                popNotice(true, 'Error: Invalid access token, please relogin.');
                return null;
            }

        } else if (response.status === 200 && response.json.detail.error_code === 7003) {
            popNotice(true, response.json.detail.error_message);
            return response.json.detail;
        } else if (response.status === 200 && response.json.detail.error_code === 7002) {
            popNotice(true, response.json.detail.error_message);
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

export async function apiRequestByRefreshToken(plugin: CloudStoragePlugin, method: string, url: string, data: any, type: string = 'json') {
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
            popNotice(true, 'Error: Invalid access token, please relogin.');
            return null;
        } else if (response.status === 200 && response.json.detail.error_code === 7003) {
            popNotice(true, response.json.detail.error_message);
            return response.json.detail;
        } else if (response.status === 200 && response.json.detail.error_code === 7002) {
            popNotice(true, response.json.detail.error_message);
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

export async function refreshAccessToken(plugin: CloudStoragePlugin) {
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
        popNotice(true, 'Get access token failed');
        return null;

    }
}

export async function getTempToken(plugin: CloudStoragePlugin, goal: string) {
    try {
        const response = await requestUrl({
            url: USER_MANAGER_BASE_URL + '/get_temp_token',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${plugin.settings.userInfo.access_token}`,
                'Content-Type': 'application/json'
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
        popNotice(true, 'Unable to obtain token');
        return null;

    }
}

export async function actionDone(plugin: CloudStoragePlugin, action: string, data: any = {}) {
    try {
        const response = await requestUrl({
            url: USER_MANAGER_BASE_URL + '/action_done',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${plugin.settings.userInfo.access_token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                "email": plugin.settings.userInfo.email ?? "",
                "action": action,
                "version": VERSION,
                "platform": Platform,
                "uuid": plugin.settings.uuid ?? "",
                "settings": safeGetSettingsValue(plugin.settings),
                "data": data
            })
        });
    } catch (error) {
        return null;
    }
    return null;
}