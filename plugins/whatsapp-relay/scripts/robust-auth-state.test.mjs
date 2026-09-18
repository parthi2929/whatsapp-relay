import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BufferJSON, initAuthCreds } from "@whiskeysockets/baileys";

import {
  credentialsBackupFile,
  credentialsFile,
  ensureCredentialIntegrity,
  hasValidCredentialsSync,
  useRobustMultiFileAuthState
} from "./robust-auth-state.mjs";

async function disposableAuthDir(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-auth-test-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

function validCredentialJson() {
  return JSON.stringify(initAuthCreds(), BufferJSON.replacer);
}

test("missing credentials support a first QR authentication", async (t) => {
  const authDir = await disposableAuthDir(t);
  const result = await ensureCredentialIntegrity(authDir);
  assert.equal(result.status, "missing");
  assert.equal(hasValidCredentialsSync(authDir), false);
});

test("credential saves create valid current and last-good files", async (t) => {
  const authDir = await disposableAuthDir(t);
  const auth = await useRobustMultiFileAuthState(authDir);
  await auth.saveCreds();

  assert.equal(hasValidCredentialsSync(authDir), true);
  assert.ok((await fs.stat(credentialsFile(authDir))).size > 0);
  assert.ok((await fs.stat(credentialsBackupFile(authDir))).size > 0);
  assert.deepEqual(
    JSON.parse(await fs.readFile(credentialsFile(authDir), "utf8"), BufferJSON.reviver),
    JSON.parse(
      await fs.readFile(credentialsBackupFile(authDir), "utf8"),
      BufferJSON.reviver
    )
  );
  assert.deepEqual(
    (await fs.readdir(authDir)).filter((name) => name.includes(".tmp-")),
    []
  );
});

test("zero-byte credentials recover from the valid last-good file", async (t) => {
  const authDir = await disposableAuthDir(t);
  const valid = validCredentialJson();
  await fs.writeFile(credentialsBackupFile(authDir), valid);
  await fs.writeFile(credentialsFile(authDir), "");

  const messages = [];
  const result = await ensureCredentialIntegrity(authDir, {
    logger: (message) => messages.push(message)
  });

  assert.equal(result.status, "restored");
  assert.equal(await fs.readFile(credentialsFile(authDir), "utf8"), valid);
  assert.match(messages[0], /credential_guard.*restored/);
});

test("invalid JSON credentials recover from the valid last-good file", async (t) => {
  const authDir = await disposableAuthDir(t);
  const valid = validCredentialJson();
  await fs.writeFile(credentialsBackupFile(authDir), valid);
  await fs.writeFile(credentialsFile(authDir), "{broken-json");

  const result = await ensureCredentialIntegrity(authDir, { logger: () => {} });

  assert.equal(result.status, "restored");
  assert.equal(await fs.readFile(credentialsFile(authDir), "utf8"), valid);
});

test("missing credentials recover from the valid last-good file", async (t) => {
  const authDir = await disposableAuthDir(t);
  const valid = validCredentialJson();
  await fs.writeFile(credentialsBackupFile(authDir), valid);

  const result = await ensureCredentialIntegrity(authDir, { logger: () => {} });

  assert.equal(result.status, "restored");
  assert.equal(await fs.readFile(credentialsFile(authDir), "utf8"), valid);
});

test("corrupt credentials with an unusable backup stop startup", async (t) => {
  const authDir = await disposableAuthDir(t);
  await fs.writeFile(credentialsFile(authDir), "");
  await fs.writeFile(credentialsBackupFile(authDir), "also invalid");

  await assert.rejects(
    ensureCredentialIntegrity(authDir),
    /credential_guard.*Refusing WhatsApp startup.*no valid last-known-good backup/
  );
});
