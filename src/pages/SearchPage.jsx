import SidebarLayout from '../layouts/SidebarLayout';
import Search from './Search';

const SearchPage = () => {
  return (
    <SidebarLayout>
      <div className="h-screen">
        <Search />
      </div>
    </SidebarLayout>
  );
};

export default SearchPage;