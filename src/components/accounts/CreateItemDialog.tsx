import { useId } from 'react';
import { useController, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { invalidateTargetLists, queryKeys } from '../../lib/queryClient';
import type { CreateItemInput } from '../../lib/types';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Form, FormShell } from '../ui/form';
import { TextField } from '../ui/Field';
import { Label } from '../ui/field-primitives';
import { Checkbox } from '../ui/checkbox';
import { PasswordField } from '../ui/PasswordField';
import { notify } from '../../state/notify';
import { toNormalisedError } from '../../lib/errors';

export interface CreateItemDialogProps {
  open: boolean;
  targetId: string;
  hasExistingItems: boolean;
  onClose: () => void;
}

/**
 * 值收集与"账号名称必填"这条校验交给 react-hook-form + zod。
 * 校验失败的呈现仍是提示条（"请填写账号名称。"），与重构前一字不差——
 * 交付方定的是 toast 反馈，不是字段下方那行红字。
 */
const schema = z.object({
  alias: z.string().min(1, '请填写账号名称。'),
  password: z.string(),
  setAsDefault: z.boolean(),
});

type FormValues = z.input<typeof schema>;

/**
 * 在某目标下新增一条外部系统账号凭据。除非显式勾选"设为默认"，否则不覆盖现有默认账号。
 *
 * 界面只有 账号名称 + 登录密码 两栏（原型 922-946，也是 Chrome / Edge 存一条口令的形状；
 * 交付方 2026-10-18 指定"字段默认保持和谷歌浏览器和 Edge 一样"）。
 * 账号名称同时作为登录用户名提交：填充链路（quick_launcher）拿的是 payload.username，
 * 只起别名不填用户名的话，"打开并填充"会填出一个空用户名。
 */
export function CreateItemDialog({ open, targetId, hasExistingItems, onClose }: CreateItemDialogProps) {
  const qc = useQueryClient();
  const formId = useId();
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      alias: '',
      password: '',
      setAsDefault: !hasExistingItems,
    },
  });
  // checkbox 要的是 checked，而 register 给的是 value，所以这颗走 useController
  const { field: defaultField } = useController({ name: 'setAsDefault', control: form.control });

  const create = useMutation({
    mutationFn: (input: CreateItemInput) => api.createItem(input),
    onSuccess: (row) => {
      void qc.invalidateQueries({ queryKey: queryKeys.targetDetail(targetId) });
      void qc.invalidateQueries({ queryKey: queryKeys.targetItems(targetId) });
      invalidateTargetLists(qc);
      void qc.invalidateQueries({ queryKey: queryKeys.stats });
      notify('success', `已新增账号：${row.accountAlias}`);
      form.reset();
      onClose();
    },
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  });

  /* 校验失败这一支不能省：省略时 RHF 什么都不做，"必填"就静默失效了。
   * 文案直接取 zod 消息，避免界面与 schema 各写一份、日后漂移。 */
  const submit = form.handleSubmit(
    (v) => {
      create.mutate({
        targetId,
        accountAlias: v.alias.trim(),
        username: v.alias.trim(),
        password: v.password,
        setAsDefault: v.setAsDefault,
      });
    },
    (errors) => {
      const first = Object.values(errors)[0];
      notify('warning', typeof first?.message === 'string' ? first.message : '请填写账号名称。');
    },
  );

  return (
    <Modal
      open={open}
      title="添加账号"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          {/* 提交钮在 <form> 之外（原型的模态就是这个形状）。靠原生 form 属性关联到那张表单，
           * 于是它走的是真实提交流：Enter 在字段里提交、点这颗也提交，两条路径同一份校验。 */}
          <Button type="submit" form={formId} variant="primary" disabled={create.isPending}>
            {create.isPending ? '保存中…' : '保存账号'}
          </Button>
        </>
      }
    >
      <Form form={form}>
        {/* noValidate 是必需的：提交钮改成 type=submit 之后，字段上那个 required 会唤起
         * 浏览器原生的校验气泡，把"请填写账号名称。"这条 toast 顶掉。校验交给 zod，
         * required 只留着表达"这栏必填"的语义。 */}
        <FormShell id={formId} noValidate onSubmit={() => void submit()} className="flex flex-col gap-5 pt-1">
          <TextField
            label="账号名称"
            placeholder="例如：admin@ashton.com"
            autoComplete="off"
            required
            {...form.register('alias')}
          />
          <PasswordField
            label="登录密码"
            placeholder="请输入登录密码"
            autoComplete="new-password"
            {...form.register('password')}
          />
          <div className="flex items-center gap-2.5 pt-1 text-sm">
            <Checkbox
              id={`${formId}-default`}
              className="size-4"
              checked={defaultField.value}
              onCheckedChange={(c) => defaultField.onChange(c === true)}
            />
            <Label htmlFor={`${formId}-default`}>设为我的默认账号</Label>
          </div>
        </FormShell>
      </Form>
    </Modal>
  );
}
