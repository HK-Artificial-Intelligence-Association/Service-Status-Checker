import * as fs from 'fs/promises';
import * as path from 'path';
import * as dotenv from 'dotenv';
import YAML from 'yamljs';
import fetch from 'node-fetch';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as ejs from 'ejs';
import MarkdownIt from 'markdown-it';
import * as fse from 'fs-extra';
import * as os from 'os';
import iconv from 'iconv-lite';

// Load environment variables
dotenv.config();

// Configuration
const MONITOR_CONTINOUSLY = process.env.MONITOR_CONTINOUSLY === 'True';
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL || '30', 10);
const MAX_HISTORY_ENTRIES = parseInt(process.env.MAX_HISTORY_ENTRIES || '100', 10);
const LOG_LEVEL = process.env.LOG_LEVEL || 'INFO';
const CHECKS_FILE = process.env.CHECKS_FILE || 'checks.yaml';
const INCIDENTS_FILE = process.env.INCIDENTS_FILE || 'incidents.md';
const TEMPLATE_FILE = process.env.TEMPLATE_FILE || 'index.html.theme';
const HISTORY_TEMPLATE_FILE = process.env.HISTORY_TEMPLATE_FILE || 'history.html.theme';
const STATUS_HISTORY_FILE = process.env.STATUS_HISTORY_FILE || 'history.json';
const HTML_OUTPUT_DIRECTORY = process.env.HTML_OUTPUT_DIRECTORY || process.cwd();
// 添加新的配置项
const NOTIFICATION_URL = process.env.NOTIFICATION_URL || '';

const md = new MarkdownIt();
const execPromise = promisify(exec);

// Service check functions
async function checkHttp(url: string, expectedCode: number): Promise<boolean> {
    try {
        const response = await fetch(url);
        return response.status === expectedCode;
    } catch (error) {
        return false;
    }
}

async function checkPing(host: string): Promise<boolean> {
    const isWindows = os.platform() === 'win32';
    const pingCommand = isWindows
        ? `ping -n 1 -w 2000 ${host}`
        : `ping -c 1 -W 2 ${host}`;

    try {
        const { stdout, stderr } = await execPromise(pingCommand, { encoding: 'buffer' });
        const output = isWindows
            ? iconv.decode(Buffer.from(stdout), 'cp936')
            : stdout.toString('utf8');

        if (isWindows) {
            // Windows: 检查是否包含 0% 丢失或 0% loss
            return /0%( 丢失| loss)/.test(output);
        } else {
            // Unix/Linux: 检查是否包含 1 received 或 1 packets received
            return /1 (packets )?received/.test(output);
        }
    } catch (error) {
        return false;
    }
}

async function checkPort(host: string, port: number): Promise<boolean> {
    const net = await import('net');
    return new Promise((resolve) => {
        const socket = net.createConnection(port, host, () => {
            socket.end();
            resolve(true);
        });
        socket.on('error', () => {
            resolve(false);
        });
    });
}

async function runChecks(checks: any[]) {
    const results = await Promise.all(
        checks.map(async (check) => {
            let status = false;
            if (check.type === 'http') {
                status = await checkHttp(check.host, check.expected_code);
            } else if (check.type === 'ping') {
                status = await checkPing(check.host);
            } else if (check.type === 'port') {
                status = await checkPort(check.host, check.port);
            }

            // 更新服务状态并检查是否需要发送通知
            updateServiceStatus(check.name,check.serviceType,check.url, status);

            return { name: check.name, status, url: check.url };
        })
    );
    return results;
}

// History management
async function loadHistory() {
    try {
        const data = await fs.readFile(STATUS_HISTORY_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return {};
    }
}

async function saveHistory(history: any) {
    await fs.writeFile(STATUS_HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
}

async function updateHistory(results: any) {
    const history = await loadHistory();
    const currentTime = new Date().toISOString();

    for (const group in results) {
        for (const check of results[group]) {
            if (!history[check.name]) {
                history[check.name] = [];
            }
            history[check.name].push({ timestamp: currentTime, status: check.status });
            history[check.name] = history[check.name].slice(-MAX_HISTORY_ENTRIES);
        }
    }

    await saveHistory(history);
}

// Main monitoring loop
async function monitorServices() {
    await fse.ensureDir(HTML_OUTPUT_DIRECTORY);

    while (true) {
        const startTs = Date.now();
        let downServices: string[] = [];

        try {
            const checksData = await fs.readFile(CHECKS_FILE, 'utf8');
            const groups = YAML.parse(checksData);

            const incidentsData = await fs.readFile(INCIDENTS_FILE, 'utf8');
            const incidents = md.render(incidentsData);

            const template = await fs.readFile(TEMPLATE_FILE, 'utf8');
            const historyTemplate = await fs.readFile(HISTORY_TEMPLATE_FILE, 'utf8');

            const results: any = {};

            for (const group of groups) {
                results[group.title] = await runChecks(group.checks);
            }

            await updateHistory(results);

            const html = ejs.render(template, {
                groups: results,
                incidents,
                last_updated: new Date().toLocaleString(),
            });

            await fs.writeFile(path.join(HTML_OUTPUT_DIRECTORY, 'index.html'), html, 'utf8');

            const historyHtml = ejs.render(historyTemplate, {
                history: await loadHistory(),
                last_updated: new Date().toLocaleString(),
            });

            await fs.writeFile(path.join(HTML_OUTPUT_DIRECTORY, 'history.html'), historyHtml, 'utf8');

            console.log(`Status page and history updated at ${new Date()}`);

            for (const group in results) {
                const groupDown = results[group].filter((check: any) => !check.status).map((check: any) => check.name);
                downServices = downServices.concat(groupDown);
            }
        } catch (error) {
            console.error(`An error occurred: ${error}`);
        }

        if (downServices.length) {
            console.warn(`Services currently down: ${downServices.join(', ')}`);
        }

        if (!MONITOR_CONTINOUSLY) {
            return;
        }

        const timeSpent = Date.now() - startTs;
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, CHECK_INTERVAL * 1000 - timeSpent)));
    }
}


// 添加一个新的接口来跟踪服务状态
interface ServiceStatus {
    consecutiveFailures: number
    lastNotified: number
}

// 创建一个 Map 来存储服务状态
const serviceStatusMap = new Map<string, ServiceStatus>();

// 添加发送通知的函数
export async function sendNotification(serviceName: string,serviceType:string,serviceURL:string) {
    if (!NOTIFICATION_URL) {
        console.log('未配置通知 URL，跳过通知')
        return
    }

    try {
        const response = await fetch(NOTIFICATION_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                serviceName: serviceName ?? '未知服务',
                serviceTag: serviceType ?? '未知类型',
                serviceUrl: serviceURL ?? '未知URL',
            })
        })

        if (response.ok) {
            console.log(`已发送 ${serviceName} 服务异常通知`)
        } else {
            console.error(`发送 ${serviceName} 服务异常通知失败：${response.statusText}`)
        }
    } catch (error) {
        console.error(`发送 ${serviceName} 服务异常通知时出错：`, error)
    }
}

// 添加更新服务状态的函数
function updateServiceStatus(serviceName: string,serviceType:string,serviceURL:string, status: boolean) {
    const serviceStatus = serviceStatusMap.get(serviceName) || { consecutiveFailures: 0, lastNotified: 0 }

    if (!status) {
        serviceStatus.consecutiveFailures++
        if (serviceStatus.consecutiveFailures >= 6 && Date.now() - serviceStatus.lastNotified > 15 * 60 * 1000) {
            sendNotification(serviceName,serviceType,serviceURL)
            serviceStatus.lastNotified = Date.now()
        }
    } else {
        serviceStatus.consecutiveFailures = 0
    }

    serviceStatusMap.set(serviceName, serviceStatus)
}

monitorServices()