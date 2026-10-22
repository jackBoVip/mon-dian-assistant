import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * shadcn/ui 的类名合并入口：clsx 负责条件拼接，tailwind-merge 负责同族工具类去重。
 *
 * 这里有一处必须知道的口径：本项目的界面规则住在 `@layer mda`，优先级**高于** utilities，
 * 所以 `cn('text-xs', 'mono')` 里赢的是 `.mono` 而不是后写的工具类——这与重构前一致。
 * twMerge 只解决"两个工具类互相打架"（`text-xs text-sm` 留后者），
 * 它不会、也不该去改自定义类与工具类之间的那条层叠关系。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
