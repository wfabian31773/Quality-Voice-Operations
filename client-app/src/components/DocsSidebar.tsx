import { Link } from 'react-router-dom';
import { docCategories, docArticles } from '../data/docs';

interface Props {
  activeSlug?: string;
}

export function DocsSidebar({ activeSlug }: Props) {
  return (
    <nav>
      {docCategories.map((cat) => {
        const articles = docArticles.filter((a) => a.category === cat.slug);
        if (articles.length === 0) return null;
        const Icon = cat.icon;
        return (
          <div key={cat.slug} className="mb-6">
            <div className="flex items-center gap-2 mb-2 px-2">
              <Icon className="h-3.5 w-3.5 text-teal" />
              <h3 className="font-display text-xs font-semibold text-slate-ink/60 uppercase tracking-wider">
                {cat.title}
              </h3>
            </div>
            <ul className="space-y-0.5">
              {articles.map((a) => (
                <li key={a.slug}>
                  <Link
                    to={`/docs/${a.slug}`}
                    className={`block text-sm font-body px-3 py-1.5 rounded-lg transition-colors ${
                      activeSlug === a.slug
                        ? 'bg-teal/10 text-teal font-semibold'
                        : 'text-slate-ink/70 hover:text-teal hover:bg-teal/5'
                    }`}
                  >
                    {a.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
