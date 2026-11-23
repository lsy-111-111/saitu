const principles = [
  {
    title: "我能在比赛里做什么？",
    description: "把做过的课程作业、实验或社团项目，和赛道实际需要的任务放在一起看。",
    icon: "shield"
  },
  {
    title: "它值得我投入吗？",
    description: "从成果、参赛条件和时间投入比较候选。想争取综测或推免时，还能看到要向本校核对什么。",
    icon: "balance"
  }
] as const;

export function InformationPrinciples() {
  return (
    <section
      aria-labelledby="home-principles-title"
      className="border-y border-border bg-white px-5 py-16 sm:px-7 md:py-20 lg:px-10"
      data-testid="information-principles"
    >
      <div className="mx-auto max-w-6xl">
        <div className="border-t border-border pt-5">
          <h2
            className="font-serif text-3xl font-semibold tracking-[-0.03em] text-ink md:text-4xl"
            id="home-principles-title"
          >
            选完之后，你会知道什么？
          </h2>
        </div>
        <div className="mt-10 grid border-y border-border md:grid-cols-2">
          {principles.map((principle, index) => (
            <article
              className={`grid grid-cols-[48px_1fr] gap-4 border-b border-border py-7 md:border-b-0 md:px-8 md:first:pl-0 md:last:pr-0 ${index > 0 ? "md:border-l md:border-border" : ""}`}
              key={principle.title}
            >
              <span className="flex h-11 w-11 items-center justify-center text-brand-500">
                <PrincipleIcon kind={principle.icon} />
              </span>
              <div>
                <h3 className="font-serif text-lg font-semibold text-ink">{principle.title}</h3>
                <p className="mt-2 text-sm leading-7 text-muted-foreground">{principle.description}</p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function PrincipleIcon({ kind }: { kind: (typeof principles)[number]["icon"] }) {
  if (kind === "shield") {
    return <svg aria-hidden="true" className="h-10 w-10" fill="none" viewBox="0 0 64 64"><path d="M32 7 52 15v15c0 13-8 22-20 27C20 52 12 43 12 30V15z" stroke="currentColor" strokeLinejoin="round" strokeWidth="3" /><path d="m23 31 6 6 13-14" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" /></svg>;
  }
  return <svg aria-hidden="true" className="h-10 w-10" fill="none" viewBox="0 0 64 64"><path d="M32 8v46M18 54h28M12 18h40M32 12l-14 6M32 12l14 6M18 18 9 20h18zM46 18l-9 20h18z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" /></svg>;
}
