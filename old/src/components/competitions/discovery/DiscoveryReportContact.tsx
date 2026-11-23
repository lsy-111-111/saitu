"use client";

import Image from "next/image";
import Link from "next/link";
import { useRef } from "react";
import { emilyQr } from "@/content/community";

export function DiscoveryReportContact() {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  function openContact() {
    dialog.current?.showModal();
    closeButton.current?.focus();
  }

  return <section className="rounded-2xl border border-brand-200 bg-brand-50 p-5 md:p-6" aria-labelledby="discovery-contact-heading">
    <h3 id="discovery-contact-heading" className="text-lg font-semibold text-ink">想了解更多竞赛信息？</h3>
    <p className="mt-2 text-sm leading-7 text-muted-foreground">可以联系 Emily 学姐，或前往竞赛组队查看交流群，自行选择想加入的群。</p>
    <div className="mt-4 flex flex-wrap gap-3">
      <button ref={trigger} type="button" onClick={openContact} aria-haspopup="dialog" aria-controls="discovery-emily-dialog" className="min-h-11 rounded-full bg-brand-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-600">联系 Emily 学姐</button>
      <Link href="/teams" className="inline-flex min-h-11 items-center rounded-full border border-brand-300 bg-white px-5 py-2.5 text-sm font-semibold text-brand-700 hover:bg-brand-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-600">前往竞赛组队</Link>
    </div>
    <dialog ref={dialog} id="discovery-emily-dialog" aria-labelledby="discovery-emily-title" aria-describedby="discovery-emily-description" onClose={() => trigger.current?.focus()} className="max-h-[calc(100dvh_-_2.5rem)] w-[calc(100%_-_2.5rem)] max-w-sm overflow-y-auto rounded-2xl border border-brand-200 bg-white p-5 text-ink shadow-xl backdrop:bg-black/45">
      <div className="flex items-center justify-between gap-4">
        <h2 id="discovery-emily-title" className="text-lg font-semibold">联系 Emily 学姐</h2>
        <button ref={closeButton} type="button" onClick={() => dialog.current?.close()} aria-label="关闭 Emily 微信二维码" className="min-h-11 rounded-full px-3 text-sm font-semibold text-brand-700 hover:bg-brand-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600">关闭</button>
      </div>
      <p id="discovery-emily-description" className="mt-2 text-sm leading-6 text-muted-foreground">用微信扫描二维码。手机上可打开大图后保存，再用微信识别。</p>
      <a href={emilyQr} target="_blank" rel="noopener noreferrer" aria-label="打开 Emily 学姐微信二维码大图" className="mx-auto mt-4 block w-fit">
        <Image alt="Emily 学姐个人微信二维码" width={240} height={240} src={emilyQr} className="h-auto max-w-full" unoptimized />
      </a>
      <p className="mt-2 text-center text-xs text-muted-foreground">点击二维码查看大图</p>
    </dialog>
  </section>;
}
