import SidebarLayout from '../layouts/SidebarLayout';

const Updates = () => {
  return (
    <SidebarLayout>
      <div className="max-w-3xl px-8 py-10">
        <h2 className="text-3xl font-semibold">Updates</h2>
        <p className="mt-3 text-sm opacity-75">
          Updates will only appear here when you provide them.
        </p>
        <div className="mt-8 rounded-xl border border-white/10 bg-black/20 px-4 py-4 text-sm opacity-70">
          No updates published yet.
        </div>
      </div>
    </SidebarLayout>
  );
};

export default Updates;