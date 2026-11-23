export const emilyQr = "/community/emily.png";

// The source cards specify “11月27日前”. Use midnight in Shanghai as the cutoff.
const novemberExpiry = "2026-11-27T00:00:00+08:00";

export const teamGroups = [
  { id: "business-entry-1", name: "25商赛资源共享组队群 · 入口一", src: "/community/group-business-1-20261120.jpg", width: 1050, height: 1575, expiresAt: novemberExpiry },
  { id: "business-entry-2", name: "25商赛资源共享组队群 · 入口二", src: "/community/group-business-2-20261120.jpg", width: 1050, height: 1575, expiresAt: novemberExpiry },
  { id: "guochuang", name: "国创赛竞赛一群", src: "/community/group-guochuang-20261120.jpg", width: 1050, height: 1575, expiresAt: novemberExpiry },
  { id: "icpc", name: "ICPC竞赛一群", src: "/community/group-icpc-20261120.jpg", width: 1050, height: 1575, expiresAt: novemberExpiry },
  { id: "market-research", name: "市调大赛竞赛一群", src: "/community/group-market-research-20261120.jpg", width: 1050, height: 1575, expiresAt: novemberExpiry },
  { id: "electronic-design", name: "全国大学生电子设计竞赛一群", src: "/community/group-electronic-design-20261120.jpg", width: 1050, height: 1617, expiresAt: novemberExpiry },
  { id: "challenge-academic", name: "大挑竞赛一群", src: "/community/group-challenge-academic-20261120.jpg", width: 1050, height: 1575, expiresAt: novemberExpiry },
  { id: "mathematical-modeling", name: "数模竞赛一群", src: "/community/group-modeling-20261120.jpg", width: 1050, height: 1575, expiresAt: novemberExpiry }
];

export function groupCodeIsCurrent(expiresAt: string, now: number) {
  return now < Date.parse(expiresAt);
}

export function groupExpiryLabel(expiresAt: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "long",
    day: "numeric"
  }).format(new Date(expiresAt));
}
