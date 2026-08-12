import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { SessionProvider } from "./auth/SessionProvider";
import { AppShell } from "./components/AppShell";
import { SignIn } from "./pages/SignIn";
import { Register } from "./pages/Register";
import { FilesPage } from "./pages/Files";
import { AdminPage } from "./pages/AdminPage";
import "./index.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing #root element in index.html");
}

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<SignIn />} />
            <Route path="/register" element={<Register />} />
            <Route path="/files" element={<FilesPage />} />
            <Route path="/admin" element={<AdminPage />} />
          </Route>
        </Routes>
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
