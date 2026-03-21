import { useEffect, useMemo, useState } from 'react';
import { Clapperboard, Play, Info, Star } from 'lucide-react';
import SidebarLayout from '../layouts/SidebarLayout';

const fallbackFeed = {
  featured: {
    id: 'fallback-featured',
    title: 'Movie Hub',
    year: 'Now',
    rating: 7.4,
    overview: 'Browse trending and popular movies, then jump to trailers and legal watch options.',
    poster: 'https://image.tmdb.org/t/p/w342/uLx4zxsQf4X2W2hV6fR4G6xkS8M.jpg',
    backdrop: 'https://image.tmdb.org/t/p/w1280/7VG2aJyIFr5xqf73kRZQ5Hf6f9Q.jpg',
    trailerUrl: 'https://www.youtube.com/results?search_query=latest+movie+trailers',
    infoUrl: 'https://www.justwatch.com/',
    type: 'movie',
  },
  sections: [],
};

const Row = ({ title, items }) => {
  return (
    <section className="mt-8">
      <h3 className="mb-3 text-lg font-semibold text-[#ff8c4f]">{title}</h3>
      <div className="scrollbar-thin scrollbar-thumb-white/15 scrollbar-track-transparent flex gap-3 overflow-x-auto pb-2">
        {items.map((item) => (
          <article
            key={item.id}
            className="group w-[146px] shrink-0 rounded-lg border border-red-500/20 bg-black/30 p-1.5 transition hover:border-red-300/40"
          >
            <img
              src={item.poster}
              alt={item.title}
              loading="lazy"
              className="h-[200px] w-full rounded-md object-cover"
            />
            <div className="px-1 py-2">
              <p className="line-clamp-2 text-xs font-semibold text-white/90">{item.title}</p>
              <div className="mt-1 flex items-center justify-between text-[10px] text-white/65">
                <span className="inline-flex items-center gap-1">
                  <Star size={10} className="text-[#ffb54a]" fill="currentColor" />
                  {item.rating || '--'}
                </span>
                <span>{item.year || '--'}</span>
              </div>
              <div className="mt-2 flex items-center gap-2 opacity-0 transition group-hover:opacity-100">
                <a
                  href={item.trailerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-full border border-red-400/40 bg-[#2b1109] px-2 py-1 text-[10px] text-[#ff9b67]"
                >
                  <Play size={10} /> Trailer
                </a>
                <a
                  href={item.infoUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-full border border-white/20 bg-black/40 px-2 py-1 text-[10px] text-white/75"
                >
                  <Info size={10} /> Info
                </a>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
};

const Movies = () => {
  const [feed, setFeed] = useState(fallbackFeed);

  useEffect(() => {
    let active = true;

    const loadFeed = async () => {
      try {
        const response = await fetch('/api/movies/feed');
        if (!response.ok) return;
        const payload = await response.json().catch(() => null);
        if (!active || !payload?.ok) return;
        if (!payload?.featured || !Array.isArray(payload?.sections)) return;
        setFeed(payload);
      } catch {
        // fallback feed stays visible
      }
    };

    loadFeed();
    return () => {
      active = false;
    };
  }, []);

  const featured = useMemo(() => feed.featured || fallbackFeed.featured, [feed.featured]);
  const sections = useMemo(() => feed.sections || [], [feed.sections]);

  return (
    <SidebarLayout>
      <div className="min-h-screen pb-10">
        <header
          className="relative h-[300px] w-full overflow-hidden border-b border-red-500/15"
          style={{
            backgroundImage: `linear-gradient(to right, rgba(8,2,1,0.95), rgba(8,2,1,0.65), rgba(8,2,1,0.95)), url(${featured.backdrop})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          }}
        >
          <div className="flex h-full max-w-6xl flex-col justify-center px-6">
            <div className="mb-2 inline-flex w-fit items-center gap-2 rounded-full border border-red-400/35 bg-black/30 px-3 py-1 text-xs text-[#ff9e6f]">
              <Clapperboard size={14} /> Movies
            </div>
            <h1 className="max-w-3xl text-4xl font-bold text-white">{featured.title}</h1>
            <p className="mt-2 max-w-2xl text-sm text-white/80">{featured.overview}</p>
            <div className="mt-4 flex items-center gap-3">
              <a
                href={featured.trailerUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-md bg-[#dd5a18] px-4 py-2 text-sm font-semibold text-white"
              >
                <Play size={14} fill="currentColor" /> Play Trailer
              </a>
              <a
                href={featured.infoUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-md border border-white/30 bg-white/10 px-4 py-2 text-sm text-white"
              >
                <Info size={14} /> More Info
              </a>
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-6xl px-6">
          {sections.map((section) => (
            <Row key={section.id} title={section.title} items={section.items || []} />
          ))}

          {sections.length === 0 && (
            <p className="mt-8 text-sm text-white/70">
              Movie feed is loading. If this persists, add a TMDB API key on the server to power live lists.
            </p>
          )}
        </main>
      </div>
    </SidebarLayout>
  );
};

export default Movies;
