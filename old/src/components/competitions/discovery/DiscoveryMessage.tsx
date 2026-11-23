"use client";

import Image from "next/image";
import { useState, type ReactNode } from "react";

export function DiscoveryMessage({ children }: { children: ReactNode }) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  return <div className="flex items-start gap-3">
    <span aria-hidden="true" className="hidden h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-white bg-brand-50 text-brand-600 shadow-soft sm:flex">
      {avatarFailed ? "✶" : <Image alt="" className="h-full w-full object-cover object-top" height={46} width={46} src="/brand/lele-avatar.png" onError={() => setAvatarFailed(true)} />}
    </span>
    <div className="min-w-0 flex-1">
      <p className="mb-2 text-sm font-semibold text-brand-700">乐乐</p>
      {children}
    </div>
  </div>;
}
