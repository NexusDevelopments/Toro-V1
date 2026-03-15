import Breadcrumb from '../components/player/Breadcrumb';
import Loader from '../components/player/Loader';
import { useLocation, Navigate } from 'react-router-dom';
import { useOptions } from '/src/utils/optionsContext';
import SidebarLayout from '../layouts/SidebarLayout';

const Player = () => {
  const location = useLocation();
  const app = location.state?.app;
  const { options } = useOptions();

  //handling when directly nav to /docs/r/
  if (!app) {
    return <Navigate to="/docs" replace />;
  }

  return (
    <SidebarLayout>
      <div className="w-[92%] mx-auto flex flex-col gap-4 mt-4 mb-8">
        <Breadcrumb theme={options.theme} name={app.appName} />
        <Loader theme={options.theme} app={app} />
      </div>
    </SidebarLayout>
  );
};

export default Player;
