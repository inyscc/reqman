import type { SVGProps } from 'react';

/**
 * 树与会话标签头共用的小图标（change: rework-visual-system-and-app-chrome）。
 *
 * 抽到单独文件只有一个原因：会话标签头不再用「集合」「文件夹」两个汉字去标注种类，
 * 改用与树里同一份绘制，两边因此不会各画一版。
 *
 * 这两个图标**不内建** `aria-hidden`：树里名称是可见的，所以调用方传 `aria-hidden`；
 * 会话标签头里图标是唯一的种类线索，调用方传 `role="img"` + `aria-label`。
 * 同一份绘制、两种无障碍语义，由调用方按场景决定。
 *
 * 这不等于「统一图标系统」——窗口控制的手写 SVG、工具栏的文本字符仍然各是各的，
 * 那件事仍然留在 Non-Goals 里。
 */

const BOX = { width: 12, height: 12, viewBox: '0 0 16 16', focusable: 'false' } as const;

/** 文件夹图标：小号实心轮廓，与请求的方法徽章形成区分。 */
export function FolderIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BOX} {...props}>
      <path
        d="M1.5 3.5A1 1 0 0 1 2.5 2.5h3.2a1 1 0 0 1 .7.3l1 1h5.1a1 1 0 0 1 1 1v7.7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"
        fill="currentColor"
        opacity="0.55"
      />
    </svg>
  );
}

/** 集合图标：叠起来的两张卡，读作「一叠条目」。
    刻意用叠放的两块实心面而不是描边字形——12px 下描边会糊成一团。 */
export function CollectionIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BOX} {...props}>
      <rect x="4" y="1.5" width="10.5" height="7.5" rx="1.8" fill="currentColor" opacity="0.4" />
      <rect x="1.5" y="6" width="10.5" height="8.5" rx="1.8" fill="currentColor" opacity="0.7" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// 变量行的操作图标（change: rework-collection-tree-and-variable-model）
//
// 同一处控件必须是**同一种形态**：这一排全是图标按钮，尺寸、描边、按下反馈一致。
// 之前那里混了「✎ 字符 + Secure 文字勾选框 + 删除/揭示 文字按钮」三种形态，
// 眼睛扫过去要先分辨种类才能分辨语义——这是纯粹的噪音。
// ---------------------------------------------------------------------------

const GLYPH = { width: 14, height: 14, viewBox: '0 0 16 16', focusable: 'false' } as const;

/** 统一的描边参数：粗细与端点一致，四个图标才像一套。 */
const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

/** 铅笔：编辑描述 / 改值（放在哪一列就是改哪一列）。 */
export function PencilIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...GLYPH} {...props}>
      <path {...STROKE} d="M11.1 2.6l2.3 2.3-7.7 7.7H3.4v-2.3z" />
      <path {...STROKE} d="M9.6 4.1l2.3 2.3" />
    </svg>
  );
}

/** 锁：secret 标记。`locked` 时锁梁闭合，未锁时锁梁开口——状态画在形状上。 */
export function LockIcon({ locked, ...rest }: { locked: boolean } & SVGProps<SVGSVGElement>) {
  return (
    <svg {...GLYPH} {...rest}>
      <rect {...STROKE} x="3.4" y="7" width="9.2" height="6.4" rx="1.6" />
      <path {...STROKE} d={locked ? 'M5.6 7V5.3a2.4 2.4 0 0 1 4.8 0V7' : 'M5.6 7V5.3a2.4 2.4 0 0 1 4.6-.9'} />
    </svg>
  );
}

/** 垃圾桶：删除。 */
export function TrashIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...GLYPH} {...props}>
      <path {...STROKE} d="M3.2 4.6h9.6" />
      <path {...STROKE} d="M6.3 4.6V3.2h3.4v1.4" />
      <path {...STROKE} d="M4.6 4.6l.6 8.2h5.6l.6-8.2" />
      <path {...STROKE} d="M6.8 7v3.6M9.2 7v3.6" />
    </svg>
  );
}

/** 眼睛：明文开关。`off` 时加一道斜线，读作「点它会盖回去」。 */
export function EyeIcon({ off = false, ...rest }: { off?: boolean } & SVGProps<SVGSVGElement>) {
  return (
    <svg {...GLYPH} {...rest}>
      <path {...STROKE} d="M1.8 8s2.5-3.9 6.2-3.9S14.2 8 14.2 8s-2.5 3.9-6.2 3.9S1.8 8 1.8 8z" />
      <circle {...STROKE} cx="8" cy="8" r="1.7" />
      {off && <path {...STROKE} d="M2.6 13.4L13.4 2.6" />}
    </svg>
  );
}
