# Przenoszenie aplikacji Paint.NET do WPF C# ze SkiaSharp (Microsoft Visual Studio)

Architektura tego edytora webowego została od podstaw zaprojektowana w sposób izomorficzny z biblioteką **SkiaSharp** (`SkiaSharp.Views.WPF`) w technologii .NET 8 / 9 WPF.

---

## 1. Wymagane pakiety NuGet w projekcie C# WPF

W pliku `.csproj` projektu WPF zainstaluj pakiety:
```xml
<ItemGroup>
    <PackageReference Include="SkiaSharp" Version="2.88.8" />
    <PackageReference Include="SkiaSharp.Views.WPF" Version="2.88.8" />
    <PackageReference Include="CommunityToolkit.Mvvm" Version="8.3.2" />
</ItemGroup>
```

---

## 2. Odpowiedniki klas i struktur (Tabela Mapowania)

| Komponent w Web (TypeScript) | Odpowiednik w C# / SkiaSharp | Opis i zastosowanie |
|---|---|---|
| `SKPoint { x, y }` | `SkiaSharp.SKPoint` | Punkt na płótnie o współrzędnych zmiennoprzecinkowych |
| `SKRectI { left, top, width, height }` | `SkiaSharp.SKRectI` | Prostokąt liczb całkowitych (DirtyRect, kafelki) |
| `SKColor { r, g, b, a }` | `SkiaSharp.SKColor` | Reprezentacja koloru RGBA (0..255) |
| `SKBlendMode` | `SkiaSharp.SKBlendMode` | Tryb mieszania (`SrcOver`, `Multiply`, `Screen`, `Overlay`, `Clear` itp.) |
| `Tile` | `class Tile { SKBitmap Bitmap; }` | Kafelek bufora rastrowego (np. 64x64 px) |
| `TileGrid` | `class TileGrid { SKBitmap[,] Tiles; }` | Siatka kafelków warstwy o stałych wymiarach |
| `Layer` | `class Layer { TileGrid Grid; SKBlendMode Mode; float Opacity; }` | Warstwa graficzna z suwakiem krycia i trybem mieszania |
| `BrushEngine` | `class BrushEngine { SKPaint StampPaint; }` | Silnik interpolacji stempli pędzla (odstęp, twardość gradientu) |
| `GraphicEngine` | `class DocumentModel { List<Layer> Layers; }` | Zarządzanie dokumentem, historią Undo i renderowaniem |

---

## 3. Implementacja kontrolki w WPF (XAML)

W pliku `MainWindow.xaml`:
```xml
<Window x:Class="PaintNetWpf.MainWindow"
        xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        xmlns:views="clr-namespace:SkiaSharp.Views.WPF;assembly=SkiaSharp.Views.WPF"
        Title="Paint.NET WPF SkiaSharp" Width="1280" Height="800"
        Background="#5A5A5A">
    
    <Grid>
        <!-- Płótno renderowane sprzętowo przez SkiaSharp -->
        <ScrollViewer HorizontalScrollBarVisibility="Auto" VerticalScrollBarVisibility="Auto">
            <Border BorderBrush="#333333" BorderThickness="1" HorizontalAlignment="Center" VerticalAlignment="Center">
                <views:SKElement x:Name="SkiaCanvas"
                                 Width="800" Height="600"
                                 PaintSurface="OnPaintSurface"
                                 MouseDown="OnCanvasMouseDown"
                                 MouseMove="OnCanvasMouseMove"
                                 MouseUp="OnCanvasMouseUp"/>
            </Border>
        </ScrollViewer>
    </Grid>
</Window>
```

---

## 4. Pipeline kompozycji z obsługą DirtyRect w C#

W pliku `MainWindow.xaml.cs`:
```csharp
private void OnPaintSurface(object sender, SKPaintSurfaceEventArgs e)
{
    var canvas = e.Surface.Canvas;
    var info = e.Info;

    // Pobierz bieżący brudny prostokąt (jeśli istnieje)
    SKRectI? dirtyRect = _engine.GetAndClearDirtyRect();

    if (dirtyRect.HasValue)
    {
        canvas.Save();
        canvas.ClipRect(dirtyRect.Value);
    }

    // 1. Rysowanie szachownicy przezroczystości (Checkerboard)
    DrawCheckerboard(canvas, dirtyRect ?? new SKRectI(0, 0, info.Width, info.Height));

    // 2. Kompozycja warstw od dołu do góry z uwzględnieniem Opacity i SKBlendMode
    foreach (var layer in _engine.Layers)
    {
        if (!layer.Visible || layer.Opacity <= 0) continue;

        using (var paint = new SKPaint
        {
            Color = new SKColor(255, 255, 255, (byte)(layer.Opacity * 255)),
            BlendMode = layer.BlendMode,
            IsAntialias = true,
            FilterQuality = SKFilterQuality.High
        })
        {
            layer.Draw(canvas, paint, dirtyRect);
        }
    }

    if (dirtyRect.HasValue)
    {
        canvas.Restore();
    }
}
```

---

## 5. Implementacja stempla pędzla z twardością w SkiaSharp

Odpowiednik metody z `Tile.ts` / `BrushEngine.ts`:
```csharp
public void StampDab(SKCanvas tileCanvas, SKPoint localPt, float radius, SKColor color, float hardness, SKBlendMode blendMode)
{
    using var paint = new SKPaint
    {
        IsAntialias = true,
        BlendMode = blendMode
    };

    if (hardness >= 99f)
    {
        paint.Color = color;
        tileCanvas.DrawCircle(localPt, radius, paint);
    }
    else
    {
        float innerRadius = radius * (hardness / 100f);
        var colors = new[] { color, color.WithAlpha(0) };
        var pos = new[] { innerRadius / radius, 1.0f };

        using var shader = SKShader.CreateRadialGradient(
            localPt,
            radius,
            colors,
            pos,
            SKShaderTileMode.Clamp);

        paint.Shader = shader;
        tileCanvas.DrawCircle(localPt, radius, paint);
    }
}
```

---

## 6. Drag and Drop warstw w WPF

W WPF lista warstw (`ListBox` lub `ItemsControl`) implementuje standardowy mechanizm `DragDrop.DoDragDrop` z biblioteki `GongSolutions.WPF.DragDrop` lub bezpośrednio przez zdarzenia `PreviewMouseMove`, `Drop`, `DragOver`. Zmiana indeksu w `ObservableCollection<Layer>` automatycznie wywołuje `SkiaCanvas.InvalidateVisual()`.
