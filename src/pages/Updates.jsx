import SidebarLayout from '../layouts/SidebarLayout';

const Updates = () => {
  return (
    <SidebarLayout>
      <div className="max-w-3xl px-8 py-10">
        <h2 className="text-3xl font-semibold">Updates</h2>
        <p className="mt-3 text-sm opacity-75">Latest changes you requested:</p>
        <div className="mt-6 rounded-xl border border-white/10 bg-black/20 px-4 py-4 text-sm">
          DuckDuckGo is now the default search engine, and Settings now lets you switch between
          DuckDuckGo and Google.
        </div>
      </div>
    </SidebarLayout>
  );
};

export default Updates;