"use client";

import { ToastContainer } from "react-toastify";

import "react-toastify/dist/ReactToastify.css";

/**
 * Mounts the toast stack once for the whole app. `RootLayout` is a server
 * component, so this is the client boundary that owns `react-toastify`'s
 * container — every `toast.x()` call anywhere in the tree renders into it.
 */
export function ToastProvider() {
  return <ToastContainer autoClose={4000} newestOnTop />;
}
