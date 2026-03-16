import Search from '../components/SearchContainer';
import QuickLinks from '../components/QuickLinks';
import SidebarLayout from '../layouts/SidebarLayout';
import { memo } from 'react';

const Home = memo(() => {
  return (
    <SidebarLayout>
      <div className="relative min-h-screen px-6 pb-20 flex flex-col items-center justify-center">
        <Search logo cls="w-full max-w-4xl mx-auto flex flex-col items-center" />
        <QuickLinks cls="w-full max-w-[40rem] mx-auto mt-8 flex flex-wrap justify-center gap-4" />
      </div>
    </SidebarLayout>
  );
});

Home.displayName = 'Home';
export default Home;
