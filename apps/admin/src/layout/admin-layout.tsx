import React from "react";
import {SidebarInset, SidebarProvider} from "@tryghost/shade/components";
import { useMatches } from "@tryghost/admin-x-framework";
import { useCurrentUser } from "@tryghost/admin-x-framework/api/current-user";
import { isContributorUser } from "@tryghost/admin-x-framework/api/users";
import { useSidebarVisibility } from "@/ember-bridge/ember-bridge";
import type { RouteHandle } from "@/ember-bridge";
import AppSidebar from "./app-sidebar";
import { MobileNavBar } from "./app-sidebar/mobile-nav-bar";
import { ContributorUserMenu } from "./app-sidebar/user-menu";

interface AdminLayoutProps {
    children: React.ReactNode;
}

export function AdminLayout({ children }: AdminLayoutProps) {
    const { data: currentUser } = useCurrentUser();
    const sidebarVisible = useSidebarVisibility();
    const matches = useMatches();
    const isFullscreenRoute = matches.some((match) => {
        const handle = match.handle as RouteHandle | undefined;
        return handle?.fullscreen === true;
    });
    const isContributor = currentUser && isContributorUser(currentUser);

    // Fullscreen routes (e.g. /settings/*) render a portal overlay with
    // their own nav. Skip the shell chrome so the two layouts don't fight.
    if (isFullscreenRoute) {
        return <>{children}</>;
    }

    // Contributors get a floating profile menu instead of the full sidebar
    if (isContributor) {
        return (
            <div className="relative h-full bg-background">
                <main className="flex h-full flex-col overflow-y-auto">
                    <div className="flex-1">{children}</div>
                </main>
                <div className="fixed bottom-3.5 left-3.5 z-20 lg:bottom-8 lg:left-8">
                    <ContributorUserMenu />
                </div>
            </div>
        );
    }

    return (
        <SidebarProvider open={!!currentUser && sidebarVisible}>
            <AppSidebar />
            <SidebarInset className={`overflow-y-auto bg-background sidebar:max-h-full ${sidebarVisible ? 'max-h-[calc(100%-var(--mobile-navbar-height))]' : 'max-h-full'}`}>
                <main className="flex-1">{children}</main>
                <MobileNavBar />
            </SidebarInset>
        </SidebarProvider>
    );
}
