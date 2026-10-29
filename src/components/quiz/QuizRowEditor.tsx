import { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/checkbox';
import { SelectField, TextAreaField, TextField } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { issueLabel, optionsToText, QTYPE_OPTIONS, qtypeLabel, tagsToText, textToOptions, textToTags } from '../../lib/quiz';
import type { QuizImportRow, QuizImportRowPatch } from '../../lib/types';

export interface QuizRowEditorProps {
  row: QuizImportRow | null;
  pending: boolean;
  onClose: () => void;
  onSubmit: (patch: QuizImportRowPatch) => void;
}

/**
 * 单行复核编辑器。只提交这张表单里的字段；答案交回后端重新裁定
 * （`answer_text` 认 "A"、"AC"、"正确"、"北京；上海" 这几种写法，见 quiz::parse::answer）。
 */
export function QuizRowEditor({ row, pending, onClose, onSubmit }: QuizRowEditorProps) {
  const [qtype, setQtype] = useState('single');
  const [stem, setStem] = useState('');
  const [options, setOptions] = useState('');
  const [answer, setAnswer] = useState('');
  const [tags, setTags] = useState('');
  const [include, setInclude] = useState(true);
  const [optionError, setOptionError] = useState('');

  useEffect(() => {
    if (!row) return;
    setQtype(row.qtype);
    setStem(row.stem);
    setOptions(optionsToText(row.options));
    setAnswer(row.answerDisplay);
    setTags(tagsToText(row.tags));
    setInclude(row.include);
    setOptionError('');
  }, [row]);

  function submit() {
    if (!row) return;
    const parsed = textToOptions(options);
    if (options.trim() && parsed.length === 0) {
      setOptionError('每行一条，形状如「A. 选项文本」；选项键只能是 A–H。');
      return;
    }
    setOptionError('');
    onSubmit({
      qtype,
      stem: stem.trim(),
      options: parsed,
      answerText: answer.trim(),
      tags: textToTags(tags),
      include,
    });
  }

  return (
    <Modal
      open={!!row}
      title={row ? `编辑第 ${row.seq} 题（${qtypeLabel(row.qtype)}）` : '编辑题目'}
      onClose={onClose}
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Checkbox id="quiz-row-include" checked={include} onCheckedChange={(v) => setInclude(v === true)} />
            <label htmlFor="quiz-row-include" className="text-sm text-ink">
              纳入发布
            </label>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={onClose}>取消</Button>
            <Button variant="primary" disabled={pending || !stem.trim()} onClick={submit}>
              {pending ? '保存中…' : '保存'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="grid gap-3">
        {row && row.issues.length > 0 ? (
          <p className="panel-notice">
            解析时标记：{row.issues.map(issueLabel).join('、')}。保存后由后端按新内容重新裁定。
          </p>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <SelectField label="题型" value={qtype} options={QTYPE_OPTIONS} onValueChange={setQtype} />
          <TextField
            label="答案"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="A / AC / 正确 / 北京；上海"
            hint="选择题写选项键；判断题写 正确/错误；填空题多个空用「；」分隔。"
          />
        </div>
        <TextAreaField
          label="题干"
          value={stem}
          rows={3}
          onChange={(e) => setStem(e.target.value)}
          hint="不写题号——题号由系统按顺序生成。"
        />
        <TextAreaField
          label="选项"
          value={options}
          rows={4}
          onChange={(e) => setOptions(e.target.value)}
          placeholder={'A. 选项一\nB. 选项二'}
          hint={optionError || '每行一条；没有选项的题型（填空/判断）留空。'}
        />
        <TextField
          label="标签"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="一次、安全规程"
          hint="用「、」或逗号分隔；标签只用于题库页的展示与检索。"
        />
      </div>
    </Modal>
  );
}
