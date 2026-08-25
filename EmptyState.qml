import QtQuick
import qs.Commons
import qs.Ui

Column {
  id: emptyRoot

  property bool scanning: false
  property int entryCount: 0
  property string filterText: ""
  property string locationLabel: ""
  property string fontFamily: Style.font.menuFamily
  property int contentSize: 13
  property int displayLargeSize: 18

  spacing: Style.space(8)

  Text {
    text: String.fromCodePoint(0xF0349)
    color: Color.menu.selectedText
    opacity: 0.8
    font.family: emptyRoot.fontFamily
    font.pixelSize: emptyRoot.displayLargeSize
    horizontalAlignment: Text.AlignHCenter
    width: parent.width
  }

  Text {
    text: emptyRoot.scanning && emptyRoot.entryCount === 0
      ? "Scanning files…"
      : (!emptyRoot.filterText.trim()
          ? emptyRoot.locationLabel + " is empty"
          : "No matches for “" + emptyRoot.filterText + "”")
    textFormat: Text.PlainText
    color: Color.menu.text
    opacity: 0.7
    font.family: emptyRoot.fontFamily
    font.pixelSize: emptyRoot.contentSize
    horizontalAlignment: Text.AlignHCenter
    width: parent.width
  }
}
