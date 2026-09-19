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
