#!/usr/bin/env node
/**
 * 在 HarmonyOS CI 执行 `cargo tauri ohos init --ci` 后，为生成的 ArkTS 工程注入
 * `ShareBridgePlugin`（`hghubx.share`）：
 *   1. 使用 `@kit.CoreFileKit` 的 `fileUri.getUriFromPath` 将沙箱路径转为合法的
 *      `file://<bundleName>/...` URI；
 *   2. 优先拉起 `ohos.want.action.sendData`（系统分享/应用选择）；
 *   3. 回退 `ohos.want.action.viewData`（系统打开方式，可继续转发/保存）；
 *   4. 最终回退 `@ohos.file.picker` 的 `DocumentViewPicker.save`（系统原生「另存为」弹窗），
 *      直接把全量日志写入用户选定的公共目录文件，确保一定弹出原生交互弹窗。
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const ohosRoot = path.join(root, "src-tauri", "gen", "ohos");

if (!fs.existsSync(ohosRoot)) {
  console.log("[patch-ohos-project] 跳过：src-tauri/gen/ohos 尚未生成");
  process.exit(0);
}

const SHARE_PLUGIN_ETS = `import {
  AsyncPluginBase,
  BridgeCallContext,
  BridgeContextRequirement,
  BridgeTypedValue,
} from '@ohos-rs/ability';
import Want from '@ohos.app.ability.Want';
import { wantConstant } from '@kit.AbilityKit';
import { fileIo, fileUri } from '@kit.CoreFileKit';
import picker from '@ohos.file.picker';

const SHARE_REQUEST_TYPE = 'hghubx.share.FileRequest';
const SHARE_RESPONSE_TYPE = 'hghubx.share.FileResponse';

interface ShareFileRequest {
  path: string;
  filename: string;
  title: string;
}

class ShareFileResponse {
  readonly outcome: string;
  readonly detail: string;

  constructor(outcome: string, detail: string) {
    this.outcome = outcome;
    this.detail = detail;
  }
}

export class ShareBridgePlugin extends AsyncPluginBase {
  readonly id: string = 'hghubx.share';
  readonly requires: BridgeContextRequirement[] = ['ability'];

  async invokeAsync(
    action: string,
    payload: BridgeTypedValue,
    context: BridgeCallContext,
  ): Promise<BridgeTypedValue> {
    if (action !== 'share-file') {
      throw new Error(\`Unsupported hghubx.share action '\${action}'\`);
    }
    if (payload.typeName !== SHARE_REQUEST_TYPE || typeof payload.value !== 'object') {
      throw new Error(\`hghubx.share.share-file requires bridge type \${SHARE_REQUEST_TYPE}\`);
    }
    const req = payload.value as ShareFileRequest;
    if (typeof req.path !== 'string' || req.path.trim().length === 0) {
      throw new Error('share-file.path must not be empty');
    }
    const filename =
      typeof req.filename === 'string' && req.filename.trim().length > 0
        ? req.filename.trim()
        : 'hghubx-logs.jsonl.txt';
    const uri: string = fileUri.getUriFromPath(req.path);
    const errors: string[] = [];

    // 1) Try implicit sendData share sheet with ability-qualified fileUri
    try {
      const sendWant: Want = {
        action: 'ohos.want.action.sendData',
        uri: uri,
        type: 'text/plain',
        flags: wantConstant.Flags.FLAG_AUTH_READ_URI_PERMISSION,
      };
      await context.abilityContext.startAbility(sendWant);
      return { typeName: SHARE_RESPONSE_TYPE, value: new ShareFileResponse('shared', uri) };
    } catch (err) {
      errors.push(\`sendData: \${String(err)}\`);
    }

    // 2) Fallback: implicit viewData open-with sheet with proper fileUri
    try {
      const viewWant: Want = {
        action: 'ohos.want.action.viewData',
        uri: uri,
        type: 'text/plain',
        flags: wantConstant.Flags.FLAG_AUTH_READ_URI_PERMISSION,
      };
      await context.abilityContext.startAbility(viewWant);
      return { typeName: SHARE_RESPONSE_TYPE, value: new ShareFileResponse('shared', uri) };
    } catch (err) {
      errors.push(\`viewData: \${String(err)}\`);
    }

    // 3) Guaranteed native dialog fallback: DocumentViewPicker.save to public storage
    try {
      const saveOptions = new picker.DocumentSaveOptions();
      saveOptions.newFileNames = [filename];
      saveOptions.fileSuffixChoices = ['文本文件|.txt'];
      const documentPicker = new picker.DocumentViewPicker(context.abilityContext);
      const uris: Array<string> = await documentPicker.save(saveOptions);
      if (!uris || uris.length === 0) {
        return { typeName: SHARE_RESPONSE_TYPE, value: new ShareFileResponse('cancelled', '') };
      }
      const destUri: string = uris[0];
      const src = fileIo.openSync(req.path, fileIo.OpenMode.READ_ONLY);
      let dst: fileIo.File;
      try {
        dst = fileIo.openSync(destUri, fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.TRUNC);
      } catch (_truncErr) {
        dst = fileIo.openSync(destUri, fileIo.OpenMode.READ_WRITE);
      }
      try {
        const chunk = new ArrayBuffer(65536);
        let offset = 0;
        while (true) {
          const n = fileIo.readSync(src.fd, chunk, { offset: offset });
          if (n <= 0) {
            break;
          }
          fileIo.writeSync(dst.fd, chunk, { length: n });
          offset += n;
        }
      } finally {
        fileIo.closeSync(src);
        fileIo.closeSync(dst);
      }
      return { typeName: SHARE_RESPONSE_TYPE, value: new ShareFileResponse('saved', destUri) };
    } catch (err) {
      errors.push(\`savePicker: \${String(err)}\`);
      throw new Error(errors.join(' | '));
    }
  }
}
`;

let patchedCount = 0;
for (const entryDir of ["entry_mobile", "entry_desktop"]) {
  const abilityDir = path.join(ohosRoot, entryDir, "src", "main", "ets", "entryability");
  const entryAbilityPath = path.join(abilityDir, "EntryAbility.ets");
  if (!fs.existsSync(entryAbilityPath)) continue;

  const pluginPath = path.join(abilityDir, "ShareBridgePlugin.ets");
  fs.writeFileSync(pluginPath, SHARE_PLUGIN_ETS);

  let code = fs.readFileSync(entryAbilityPath, "utf8");
  if (!code.includes("ShareBridgePlugin")) {
    const importAnchor = "import { UrlPlugin } from '@ohos-rs/ability-plugin-url';";
    if (!code.includes(importAnchor)) {
      throw new Error(`[patch-ohos-project] ${entryAbilityPath} 缺少预期的 UrlPlugin 导入行`);
    }
    code = code.replace(
      importAnchor,
      `${importAnchor}\nimport { ShareBridgePlugin } from './ShareBridgePlugin';`,
    );

    const pluginAnchor = "new LazyPlugin(() => new UrlPlugin()),";
    if (!code.includes(pluginAnchor)) {
      throw new Error(`[patch-ohos-project] ${entryAbilityPath} 缺少预期的 bridgePlugins 注册项`);
    }
    code = code.replace(
      pluginAnchor,
      `${pluginAnchor}\n    new LazyPlugin(() => new ShareBridgePlugin()),`,
    );
    fs.writeFileSync(entryAbilityPath, code);
  }
  patchedCount += 1;
}

if (patchedCount === 0) {
  throw new Error("[patch-ohos-project] 未找到任何 EntryAbility.ets，无法注入鸿蒙分享插件");
}
console.log(`[patch-ohos-project] 已向 ${patchedCount} 个 HarmonyOS entry 注入 ShareBridgePlugin`);
