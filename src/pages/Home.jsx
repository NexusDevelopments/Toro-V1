import Search from '../components/SearchContainer';
import QuickLinks from '../components/QuickLinks';
import SidebarLayout from '../layouts/SidebarLayout';
import { memo } from 'react';

const Home = memo(() => {
  return (
    <SidebarLayout>
      <div className="relative min-h-screen px-6 pt-10 pb-20">
        <Search logo={false} cls="w-full max-w-4xl mx-auto flex flex-col items-center" />
        <QuickLinks cls="w-full max-w-[40rem] mx-auto mt-10 flex flex-wrap justify-center gap-4" />
      </div>
    </SidebarLayout>
  );
});

Home.displayName = 'Home';
export default Home;
