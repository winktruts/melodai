const fetch = require('node-fetch');
const fs = require('fs').promises;
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const BASE_URL = 'https://hamster.xar.name/index.php/api/v1';
const MAILTM_API = 'https://api.mail.tm';
const MAX_ACCOUNTS_PER_REF = 20;

const headers = {
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.8',
    'content-type': 'application/json',
    'priority': 'u=1, i',
    'sec-ch-ua': '"Chromium";v="134", "Not:A-Brand";v="24", "Brave";v="134"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'cross-site',
    'sec-gpc': '1',
    'Referer': 'https://web.melodai.pro/',
    'Referrer-Policy': 'strict-origin-when-cross-origin'
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const log = {
    info: (msg) => console.log(`[ℹ] ${msg}`),
    success: (msg) => console.log(`[✔] ${msg}`),
    error: (msg) => console.log(`[✘] ${msg}`),
    warn: (msg) => console.log(`[⚠] ${msg}`),
    section: (msg) => console.log(`\n=== ${msg} ===\n`)
};

async function readRefCode(filename) {
    try {
        const content = await fs.readFile(filename, 'utf8');
        return content.trim();
    } catch (error) {
        log.error(`Failed to read ${filename}: ${error.message}`);
        return null;
    }
}

async function getTempEmail() {
    log.info('Fetching domain from Mail.tm...');
    const res = await fetch(`${MAILTM_API}/domains`, { method: 'GET' });
    const domainsData = await res.json();
    if (!domainsData['hydra:member'] || domainsData['hydra:member'].length === 0) throw new Error('No domains available');
    const domain = domainsData['hydra:member'][0].domain;
    const username = Math.random().toString(36).substring(2, 15);
    const email = `${username}@${domain}`;
    const password = 'password123'; 

    log.info(`Creating email: ${email}`);
    const emailRes = await fetch(`${MAILTM_API}/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: email, password })
    });
    const emailData = await emailRes.json();
    if (!emailData.id) throw new Error('Failed to create email');

    const tokenRes = await fetch(`${MAILTM_API}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: emailData.address, password })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.token) throw new Error('Failed to get token');

    return { email: emailData.address, password, token: tokenData.token };
}

async function getVerificationCode(emailToken) {
    log.info('Waiting for verification code...');
    const maxAttempts = 5;
    const delayMs = 5000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        log.info(`Attempt ${attempt}/${maxAttempts}...`);
        const res = await fetch(`${MAILTM_API}/messages`, {
            headers: { 'Authorization': `Bearer ${emailToken}` }
        });
        const messages = await res.json();

        if (messages['hydra:member'] && messages['hydra:member'].length > 0) {
            const messageData = messages['hydra:member'][0];
            const messageRes = await fetch(`${MAILTM_API}/messages/${messageData.id}`, {
                headers: { 'Authorization': `Bearer ${emailToken}` }
            });
            const message = await messageRes.json();

            let codeMatch = message.text.match(/\d{6}/);
            if (!codeMatch) {
                log.info('Trying to extract code from subject...');
                codeMatch = messageData.subject.match(/\d{6}/);
            }

            if (codeMatch) {
                log.success(`Verification code found: ${codeMatch[0]}`);
                return codeMatch[0];
            }
            throw new Error('Verification code not found');
        }

        if (attempt < maxAttempts) await delay(delayMs);
    }
    throw new Error('No verification message received');
}

async function registerAccount(refCode) {
    const { email, password, token } = await getTempEmail();
    log.info(`Sending verification request for ${email}...`);
    const emailRes = await fetch(`${BASE_URL}/send_r_email`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email, type: 0 })
    });
    const emailData = await emailRes.json();
    if (emailData.code !== 200) throw new Error('Failed to send verification email');

    const code = await getVerificationCode(token);
    log.info(`Logging in with code ${code}...`);
    const loginRes = await fetch(`${BASE_URL}/login_email`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email, code, invite_code: refCode, platform: 2 })
    });
    const loginData = await loginRes.json();
    if (loginData.code !== 200) throw new Error('Registration failed');

    return {
        email,
        password,
        token: loginData.data.user_data.token,
        member_id: loginData.data.user_data.id
    };
}

async function getTasks(token, member_id) {
    log.info('Fetching task list...');
    const res = await fetch(`${BASE_URL}/getTaskList`, {
        method: 'POST',
        headers: { ...headers, 'authorization': token },
        body: JSON.stringify({ member_id: member_id.toString() })
    });
    const data = await res.json();
    if (data.code !== 200) {
        log.error(`Failed to fetch tasks: ${data.msg || 'Unknown error'}`);
        return [];
    }
    return data.data;
}

async function completeTask(token, member_id, task_id, task_name) {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        log.info(`Completing task "${task_name}" (Attempt ${attempt}/${maxRetries})...`);
        const res = await fetch(`${BASE_URL}/completeTask`, {
            method: 'POST',
            headers: { ...headers, 'authorization': token },
            body: JSON.stringify({ en: 2, member_id: member_id.toString(), task_id })
        });
        const data = await res.json();
        if (data.code === 200) return true;
        log.warn(`Failed to complete task "${task_name}": ${data.msg || 'Unknown error'}`);
        await delay(2000);
    }
    return false;
}

async function claimReward(token, member_id, task_id, task_name) {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        log.info(`Claiming reward for task "${task_name}" (Attempt ${attempt}/${maxRetries})...`);
        const res = await fetch(`${BASE_URL}/claimReward`, {
            method: 'POST',
            headers: { ...headers, 'authorization': token },
            body: JSON.stringify({ member_id: member_id.toString(), task_id, en: 2 })
        });
        const data = await res.json();
        if (data.code === 200) return data.data.rewards;
        log.warn(`Failed to claim reward for "${task_name}": ${data.msg || 'Unknown error'}`);
        await delay(2000);
    }
    return 0;
}

async function claimMiningPool(token, member_id) {
    log.info('Attempting to claim mining pool coin...');
    const addRes = await fetch(`${BASE_URL}/add_receive`, {
        method: 'POST',
        headers: { ...headers, 'authorization': token },
        body: JSON.stringify({ member_id: member_id.toString(), pool_id: member_id.toString(), en: 2 })
    });
    const addData = await addRes.json();

    if (addData.code === 200) {
        const receiveRes = await fetch(`${BASE_URL}/pool_mining_received`, {
            method: 'POST',
            headers: { ...headers, 'authorization': token },
            body: JSON.stringify({
                member_id: member_id.toString(),
                en: 2,
                receive_id: addData.data.money,
                coin_id: addData.data.coin_id
            })
        });
        const receiveData = await receiveRes.json();
        if (receiveData.code === 200) {
            return receiveData.data.amount;
        } else {
            log.error(`Failed to receive mining pool: ${receiveData.msg || 'Unknown error'}`);
        }
    } else {
        log.error(`Failed to add mining pool: ${addData.msg || 'Unknown error'}`);
    }
    return 0;
}

async function processTasksAndMining(token, member_id) {
    log.section('Processing Task List');
    const tasks = await getTasks(token, member_id);
    if (tasks.length === 0) {
        log.warn('No tasks available or failed to fetch task list');
    }
    for (const task of tasks) {
        if (task.completed === 0) {
            const completed = await completeTask(token, member_id, task.id, task.task_name);
            if (completed) {
                const reward = await claimReward(token, member_id, task.id, task.task_name);
                if (reward > 0) {
                    log.success(`Task "${task.task_name}" completed - Reward: ${reward}`);
                } else {
                    log.error(`Failed to claim reward for "${task.task_name}"`);
                }
            } else {
                log.error(`Failed to complete task "${task.task_name}" after multiple attempts`);
            }
            await delay(1000);
        } else {
            log.info(`Task "${task.task_name}" already completed`);
        }
    }

    log.section('Claiming Mining Pool Coin');
    const miningAmount = await claimMiningPool(token, member_id);
    if (miningAmount > 0) {
        log.success(`Mining pool coin claimed - Amount: ${miningAmount}`);
    } else {
        log.warn('No mining pool coin claimed');
    }
}

async function main() {
    log.section('MelodAI Auto Bot - AirdorpInsiders');
    const refCode = await readRefCode('code.txt');
    if (!refCode) {
        log.error('File code.txt not found or empty. Please provide a referral code.');
        rl.close();
        return;
    }

    log.info(`Using referral code: ${refCode}`);
    const count = await new Promise(resolve => rl.question('[?] Number of accounts to create (max 20): ', resolve));
    const numAccounts = Math.min(parseInt(count) || 0, MAX_ACCOUNTS_PER_REF);

    if (numAccounts <= 0) {
        log.error('Invalid number of accounts. Please enter a number between 1 and 20.');
        rl.close();
        return;
    }

    const accounts = [];
    for (let i = 0; i < numAccounts; i++) {
        log.section(`Creating Account ${i + 1}/${numAccounts}`);
        try {
            const account = await registerAccount(refCode);
            log.success(`Account ${account.email} successfully created`);
            await processTasksAndMining(account.token, account.member_id);
            accounts.push(account);
            await delay(2000); 
        } catch (error) {
            log.error(`Failed to create account: ${error.message}`);
        }
    }

    try {
        await fs.writeFile('accounts.json', JSON.stringify(accounts, null, 2));
        log.success(`Total ${accounts.length} accounts saved to accounts.json`);
    } catch (error) {
        log.error(`Failed to save accounts: ${error.message}`);
    }

    rl.close();
}

main().catch(error => {
    log.error(`Fatal error: ${error.message}`);
    rl.close();
});