import { Route, Routes } from "react-router-dom";

import EpistemicMap from "./pages/EpistemicMap";
import UploadLanding from "./pages/UploadLanding";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<UploadLanding />} />
      <Route path="/map/:sessionId" element={<EpistemicMap />} />
    </Routes>
  );
}
