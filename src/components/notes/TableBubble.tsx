import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { Button } from '../ui/Button';
import { Icon, type IconName } from '../ui/Icon';

/**
 * 表格浮动那一行：只在光标落进表里时出现。
 *
 * 不放进「插入」菜单，是因为这些动作针对的是**当前那张表**——
 * 光标不在表里时它们必须不出现，而不是出现了按了没反应。
 */
function BubbleButton({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }) {
  return (
    <Button variant="bare" className="note-tool note-tool--small" aria-label={label} title={label} onClick={onClick}>
      <Icon name={icon} size={14} />
    </Button>
  );
}

export function TableBubble({ editor }: { editor: Editor | null }) {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const refresh = () => bump((n) => n + 1);
    editor.on('transaction', refresh);
    return () => {
      editor.off('transaction', refresh);
    };
  }, [editor]);

  if (!editor || !editor.isEditable || !editor.isActive('table')) return null;

  const chain = () => editor.chain().focus();

  return (
    <div className="note-table-bubble" role="group" aria-label="表格操作">
      <BubbleButton icon="plus" label="在上方加行" onClick={() => chain().addRowBefore().run()} />
      <BubbleButton icon="minus" label="删除当前行" onClick={() => chain().deleteRow().run()} />
      <span className="note-toolbar__gap" aria-hidden />
      <BubbleButton icon="plus" label="在左侧加列" onClick={() => chain().addColumnBefore().run()} />
      <BubbleButton icon="minus" label="删除当前列" onClick={() => chain().deleteColumn().run()} />
      <span className="note-toolbar__gap" aria-hidden />
      <BubbleButton icon="trash" label="删除整张表" onClick={() => chain().deleteTable().run()} />
    </div>
  );
}
