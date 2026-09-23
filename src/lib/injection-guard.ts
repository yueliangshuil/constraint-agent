/**
 * Prompt 注入防护（第一道防线：入库前检测）
 * 规则文档是不可信输入——攻击者可能在文档中藏"忽略以上指令"类内容，
 * 诱导结构化抽取或 Agent 规划阶段的模型越权。
 * 命中注入模式的文档拒绝入库；结构化抽取时另有数据隔离包裹（第二道防线）。
 */

const INJECTION_PATTERNS: RegExp[] = [
  /忽略(以上|前面|之前|上述|下面|以下)?(所有|全部)?指令/gi,
  /ignore\s+((all|previous|above|following|other)\s+)*instructions/gi,
  /disregard\s+(all\s+)?instructions/gi,
  /forget\s+(your\s+)?(system\s+)?prompt/gi,
  /你的系统提示(词)?/gi,
  /(override|覆盖).{0,10}(指令|instruction)/gi,
];

/**
 * 检测注入内容，命中返回命中的模式原文，未命中返回 null
 */
export function detectInjection(text: string): string | null {
  for (const pattern of INJECTION_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}
