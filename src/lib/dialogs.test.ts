import { describe, expect, it } from 'vitest';
import { openFile, saveFileDialog, saveTextFile } from './dialogs';
import { ApiError } from './api';

/** 非 Tauri 环境（jsdom/浏览器预览）：对话框必须诚实报错，不得伪造路径或静默成功。 */
describe('dialogs（非 Tauri 降级）', () => {
  it('openFile 抛 NOT_TAURI', async () => {
    await expect(openFile()).rejects.toBeInstanceOf(ApiError);
    await expect(openFile()).rejects.toMatchObject({ code: 'NOT_TAURI' });
  });

  it('saveFileDialog 抛 NOT_TAURI', async () => {
    await expect(saveFileDialog({ defaultPath: 'a.csv' })).rejects.toMatchObject({ code: 'NOT_TAURI' });
  });

  it('saveTextFile 抛 NOT_TAURI，不写出任何假文件', async () => {
    await expect(saveTextFile({ defaultPath: 'a.csv' }, 'x')).rejects.toMatchObject({ code: 'NOT_TAURI' });
  });
});
