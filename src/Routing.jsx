import { Suspense, memo } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import Fallback from './fallback';

const Routing = memo(({ pages }) => {
  const location = useLocation();

  return (
    <Suspense fallback={<Fallback />}>
      <div key={location.pathname} className="route-fade-enter">
        <Routes location={location}>
          {pages.map((page, index) => (
            <Route key={`${page.path}-${index}`} path={page.path} element={page.element} />
          ))}
        </Routes>
      </div>
    </Suspense>
  );
});

Routing.displayName = 'Routing';
export default Routing;
