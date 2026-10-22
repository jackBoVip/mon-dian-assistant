//! 全站图标：只登记**实际用到**的图标数据（IconNode），不做全量 re-export。
//! 这里是图标名的唯一来源；消费方一律用 `<Icon name="…" />`，不得直接 import lucide。
//! 例外是下面那两枚原型逐字照抄的自定义节点（`palette`、`settings`）——它们不是 lucide 的画法。
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Clock,
  CloudOff,
  Copy,
  Database,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileSpreadsheet,
  Info,
  KeyRound,
  Lock,
  LockOpen,
  Moon,
  LogOut,
  PanelLeft,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Star,
  StarOff,
  Sun,
  Trash,
  TriangleAlert,
  Undo2,
  Upload,
  User,
  X,
  Zap,
} from 'lucide';
import type { IconNode } from 'morphicons/react';
import type { PageKey } from '../../lib/pageMeta';

/**
 * 原型 `#themeColorBtn` 里那枚调色板：一整圈 + 三枚小环。
 * lucide 的 `Palette` 是另一种画法（缺口朝右下、点是实心小圆），交付方要求与原型一致，
 * 所以这里逐字照抄附件的 `d` 与 `circle`。morphicons 会把 IconNode 归一成单条 path，
 * `circle` 元素照样进得来。
 */
const PROTOTYPE_PALETTE: IconNode = [
  ['path', { d: 'M12 21a9 9 0 1 1 9-9c0 2.5-2 4.5-4.5 4.5H15a2 2 0 0 0-2 2v.5a2 2 0 0 1-2 2z' }],
  ['circle', { cx: 8, cy: 11, r: 1.5 }],
  ['circle', { cx: 12, cy: 7, r: 1.5 }],
  ['circle', { cx: 16, cy: 11, r: 1.5 }],
];

/** 原型 `#settingsBtn` 里那枚齿轮（两段 path）。原先用的 lucide `Settings2` 是滑杆，形状不同。 */
const PROTOTYPE_COG: IconNode = [
  [
    'path',
    {
      d: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
    },
  ],
  ['path', { d: 'M15 12a3 3 0 11-6 0 3 3 0 016 0z' }],
];

/**
 * 左栏「导入系统 / 导出系统」那两颗钮与导入弹窗里的两枚箭头（原型 658-676、819-840）。
 * 交付方 2026-10-18 点名图标要与原型一致：lucide 的 `Download` / `Upload` 是「托盘 + 箭头」的另一种画法
 * （箭头不带穿托盘的那段竖线），所以这里把原型的 `path`+`polyline`+`line` 逐字转写成三条 `d`。
 * morphicons 会把 IconNode 归一成单条 path，线段与折线转 `M…L…` 形状不变。
 */
const PROTOTYPE_IMPORT_TRAY: IconNode = [
  ['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }],
  ['path', { d: 'M7 10l5 5 5-5' }],
  ['path', { d: 'M12 15V3' }],
];
const PROTOTYPE_EXPORT_TRAY: IconNode = [
  ['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }],
  ['path', { d: 'M17 8l-5-5-5 5' }],
  ['path', { d: 'M12 3v12' }],
];

export const ICONS = {
  check: Check,
  checkCircle: CircleCheck,
  chevronDown: ChevronDown,
  chevronNext: ChevronRight,
  clock: Clock,
  copy: Copy,
  database: Database,
  download: Download,
  edit: Pencil,
  externalLink: ExternalLink,
  eye: Eye,
  eyeOff: EyeOff,
  /* 导入框选中文件后放大显示的那枚表文件图标。不按 csv/xlsx 分叉：真实格式是后端按文件内容嗅探的，
   * 扩展名说了不算，图标跟着扩展名走会报假信息。 */
  fileSheet: FileSpreadsheet,
  exportTray: PROTOTYPE_EXPORT_TRAY,
  importTray: PROTOTYPE_IMPORT_TRAY,
  info: Info,
  key: KeyRound,
  lock: Lock,
  lockOpen: LockOpen,
  logout: LogOut,
  palette: PROTOTYPE_PALETTE,
  panel: PanelLeft,
  plus: Plus,
  refresh: RefreshCw,
  search: Search,
  settings: PROTOTYPE_COG,
  shield: ShieldCheck,
  filter: SlidersHorizontal,
  star: Star,
  starOff: StarOff,
  trash: Trash,
  warning: TriangleAlert,
  undo: Undo2,
  upload: Upload,
  close: X,
  zap: Zap,
  user: User,
  cloudOff: CloudOff,
  /* 认证页右上角主题切换器的三档：内蒙电力绿用闪电，浅/深各用日/月。
   * 只登记在这里，业务页仍不得直接 import lucide。 */
  sun: Sun,
  moon: Moon,
} satisfies Record<string, IconNode>;

export type IconName = keyof typeof ICONS;

/** 业务页 → 图标。key 与 lib/pageMeta::PageKey 一致（少任何一枚都会 TS 报错，不会再悄悄漂移）。 */
export const PAGE_ICONS: Record<PageKey, IconName> = {
  accounts: 'key',
  members: 'user',
  audit: 'clock',
  settings: 'settings',
  launcher: 'zap',
  data: 'database',
};
