import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  BufferJSON,
  initAuthCreds,
  proto
} from "@whiskeysockets/baileys";

const fileWriteTails = new Map();

function fixedFileName(file) {
  return file?.replace(/\//g, "__")?.replace(/:/g, "-");
}

function parseJson(value) {
  return JSON.parse(value, BufferJSON.reviver);
}

function isCredentialObject(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      Number.isInteger(value.registrationId) &&
      value.noiseKey &&
      value.signedIdentityKey &&
      value.signedPreKey &&
      typeof value.advSecretKey === "string"
  );
}

function parseAndValidateCredentials(text, label) {
  if (!text?.trim()) {
    throw new Error(`${label} is empty.`);
  }
  const parsed = parseJson(text);
  if (!isCredentialObject(parsed)) {
    throw new Error(`${label} does not contain a complete WhatsApp credential object.`);
  }
  return parsed;
}

async function readValidCredentials(filePath) {
  try {
    const text = await fsp.readFile(filePath, "utf8");
    parseAndValidateCredentials(text, filePath);
    return { valid: true, text };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { valid: false, missing: true, error };
    }
    return { valid: false, missing: false, error };
  }
}

async function atomicWriteFile(filePath, content) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  let handle = null;
  try {
    handle = await fsp.open(tempPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(tempPath, filePath);
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await fsp.unlink(tempPath).catch(() => {});
  }
}

function queueFileOperation(filePath, operation) {
  const previous = fileWriteTails.get(filePath) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  fileWriteTails.set(filePath, current);
  return current.finally(() => {
    if (fileWriteTails.get(filePath) === current) {
      fileWriteTails.delete(filePath);
    }
  });
}

export function credentialsBackupFile(authDir) {
  return path.join(authDir, "creds.last-good.json");
}

export function credentialsFile(authDir) {
  return path.join(authDir, "creds.json");
}

export function hasValidCredentialsSync(authDir) {
  try {
    const text = fs.readFileSync(credentialsFile(authDir), "utf8");
    parseAndValidateCredentials(text, credentialsFile(authDir));
    return true;
  } catch {
    return false;
  }
}

export async function ensureCredentialIntegrity(
  authDir,
  { logger = (message) => process.stderr.write(`${message}\n`) } = {}
) {
  await fsp.mkdir(authDir, { recursive: true });
  const currentPath = credentialsFile(authDir);
  const backupPath = credentialsBackupFile(authDir);
  const current = await readValidCredentials(currentPath);

  if (current.valid) {
    await atomicWriteFile(backupPath, current.text);
    return { status: "valid", file: currentPath, backupFile: backupPath };
  }

  const backup = await readValidCredentials(backupPath);
  if (backup.valid) {
    await atomicWriteFile(currentPath, backup.text);
    logger(
      `[credential_guard] restored ${currentPath} from ${backupPath} after ${
        current.missing ? "a missing credential file" : current.error.message
      }`
    );
    return { status: "restored", file: currentPath, backupFile: backupPath };
  }

  if (current.missing) {
    return { status: "missing", file: currentPath, backupFile: backupPath };
  }

  throw new Error(
    `[credential_guard] Refusing WhatsApp startup because ${currentPath} is corrupt and no valid last-known-good backup exists. ${current.error.message}`
  );
}

export async function useRobustMultiFileAuthState(folder) {
  await ensureCredentialIntegrity(folder);

  const writeData = async (data, file) => {
    const filePath = path.join(folder, fixedFileName(file));
    return queueFileOperation(filePath, async () => {
      const serialized = JSON.stringify(data, BufferJSON.replacer);
      if (file === "creds.json") {
        parseAndValidateCredentials(serialized, filePath);
        const current = await readValidCredentials(filePath);
        if (current.valid) {
          await atomicWriteFile(credentialsBackupFile(folder), current.text);
        }
      }
      await atomicWriteFile(filePath, serialized);
      if (file === "creds.json") {
        const backup = await readValidCredentials(credentialsBackupFile(folder));
        if (!backup.valid) {
          await atomicWriteFile(credentialsBackupFile(folder), serialized);
        }
      }
    });
  };

  const readData = async (file) => {
    const filePath = path.join(folder, fixedFileName(file));
    try {
      return await queueFileOperation(filePath, async () => {
        const text = await fsp.readFile(filePath, "utf8");
        return parseJson(text);
      });
    } catch (error) {
      if (file === "creds.json" && error?.code !== "ENOENT") {
        throw new Error(
          `[credential_guard] Unable to read ${filePath}: ${error.message}`,
          { cause: error }
        );
      }
      return null;
    }
  };

  const removeData = async (file) => {
    const filePath = path.join(folder, fixedFileName(file));
    await queueFileOperation(filePath, async () => {
      await fsp.unlink(filePath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    });
  };

  const creds = (await readData("creds.json")) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}.json`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const file = `${category}-${id}.json`;
              tasks.push(value ? writeData(value, file) : removeData(file));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => writeData(creds, "creds.json")
  };
}
