import SidebarLayout from '../layouts/SidebarLayout';
import pkg from '../../package.json';

const updates = [
  'Toro V1 branding and red/black visual theme update.',
  'Railway deployment compatibility improvements.',
  'Sidebar navigation added for faster access to core sections.',
];

const Updates = () => {
  return (
    <SidebarLayout>
      <div className="max-w-3xl px-8 py-10">
        <h2 className="text-3xl font-semibold">Updates</h2>
        <p className="mt-2 text-sm opacity-75">Current version: v{pkg.version}</p>

        <div className="mt-8 space-y-3">
          {updates.map((item) => (
            <div key={item} className="rounded-xl border border-white/10 bg-black/20 px-4 py-3">
              {item}
            </div>
          ))}
        </div>
      </div>
    </SidebarLayout>
  );
};

export default Updates;