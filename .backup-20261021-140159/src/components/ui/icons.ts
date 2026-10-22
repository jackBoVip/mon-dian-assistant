//! 全站图标：只登记**实际用到**的图标组件，不做全量 re-export。
//! 这里是图标名的唯一来源；消费方一律用 `<Icon name="…" />`，不得直接 import lucide-react。
//! 例外是下面那四枚原型逐字照抄的自定义节点（`palette`、`settings`、`importTray`、`exportTray`）——
//! 它们不是 lucide 现成的画法，用 createLucideIcon 把原型的节点包成同规格的组件。
import { createLucideIcon } from 'lucide-react';
import type { IconNode, LucideIcon } from 'lucide-react';
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
  ListTree,
  Lock,
  LockOpen,
  Moon,
  LogOut,
  PanelLeft,
  Pencil,
  Plus,
  RefreshCw,
  ScrollText,
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
  Users,
  X,
  Zap,
} from 'lucide-react';

/**
 * 原型 `#themeColorBtn` 里那枚调色板：一整圈 + 三枚小环。
 * lucide 的 `Palette` 是另一种画法（缺口朝右下、点是实心小圆），交付方要求与原型一致，
 * 所以这里逐字照抄附件的 `d` 与 `circle`。lucide 的 IconNode 就是 `[标签, 属性]` 元组数组，
 * `circle` 元素原样上屏，不再被折算成单条 path。
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
      d: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-.426-1.756-2.924-1.756-3.35 0a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
    },
  ],
  ['path', { d: 'M15 12a3 3 0 11-6 0 3 3 0 016 0z' }],
];

/**
 * 左栏「导入系统 / 导出系统」那两颗钮与导入弹窗里的两枚箭头（原型 658-676、819-840）。
 * 交付方 2026-10-18 点名图标要与原型一致：lucide 的 `Download` / `Upload` 是「托盘 + 箭头」的另一种画法
 * （箭头不带穿托盘的那段竖线），所以这里把原型的 `path`+`polyline`+`line` 逐字转写成三条 `d`。
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

/**
 * 四枚原型自定义节点的**原始数据**，与上面的组件分开导出：
 * ICONS 里装的是组件而不是节点，守卫要逐字验"带的是附件那段 `d`"只能读这里。
 */
export const PROTOTYPE_NODES = {
  palette: PROTOTYPE_PALETTE,
  settings: PROTOTYPE_COG,
  importTray: PROTOTYPE_IMPORT_TRAY,
  exportTray: PROTOTYPE_EXPORT_TRAY,
} as const;

const Palette = createLucideIcon('palette', PROTOTYPE_PALETTE);
const Settings = createLucideIcon('settings', PROTOTYPE_COG);
const ImportTray = createLucideIcon('import-tray', PROTOTYPE_IMPORT_TRAY);
const ExportTray = createLucideIcon('export-tray', PROTOTYPE_EXPORT_TRAY);

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
  exportTray: ExportTray,
  importTray: ImportTray,
  info: Info,
  key: KeyRound,
  listTree: ListTree,
  lock: Lock,
  lockOpen: LockOpen,
  logout: LogOut,
  palette: Palette,
  panel: PanelLeft,
  plus: Plus,
  refresh: RefreshCw,
  search: Search,
  scrollText: ScrollText,
  settings: Settings,
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
  users: Users,
  cloudOff: CloudOff,
  /* 认证页右上角主题切换器的三档：内蒙电力绿用闪电，浅/深各用日/月。
   * 只登记在这里，业务页仍不得直接 import lucide-react。 */
  sun: Sun,
  moon: Moon,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;
