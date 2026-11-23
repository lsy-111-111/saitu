import Link from "next/link";

const contacts = [
  {
    title: "加入竞赛交流群",
    description: "交流赛事信息，寻找一起参赛的伙伴。",
    label: "查看竞赛交流群",
    href: "/teams",
  },
  {
    title: "联系 Emily 学姐",
    description: "对比赛或赛道还有疑问，可以添加微信进一步交流。",
    label: "添加 Emily 微信",
    href: "/about#contact",
  },
] as const;

export function ResultContactCards() {
  return (
    <section aria-labelledby="result-contact-heading" className="mt-8 border-t border-brand-200 pt-6" data-testid="result-contact-cards">
      <h2 id="result-contact-heading" className="font-serif text-2xl font-semibold text-ink">
        关于这些竞赛，还想了解更多？
      </h2>
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        {contacts.map(contact => (
          <article key={contact.href} className="flex flex-col rounded-2xl border border-brand-200 bg-white p-5 md:p-6">
            <h3 className="text-lg font-semibold text-brand-800">{contact.title}</h3>
            <p className="mt-3 flex-1 text-sm leading-7 text-muted-foreground">{contact.description}</p>
            <Link href={contact.href} target="_blank" rel="noopener noreferrer"
              className="mt-5 inline-flex min-h-11 w-fit items-center justify-center rounded-full border border-brand-300 bg-brand-50 px-5 py-2 text-sm font-semibold text-brand-700 transition-colors hover:border-brand-500 hover:bg-brand-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-500">
              {contact.label}<span aria-hidden="true" className="ml-2">↗</span><span className="sr-only">（在新标签页打开）</span>
            </Link>
          </article>
        ))}
      </div>
    </section>
  );
}
